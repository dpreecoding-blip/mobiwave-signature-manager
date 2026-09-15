#!/usr/bin/env python3
"""MobiWave outbound mail signature milter.

Runs on the existing Postfix/Exim mail host. It never stores message bodies.
If the Signature Manager API is unavailable or returns an error, the message is
accepted unchanged (fail-open).
"""

import json
import logging
import os
import re
import ssl
import urllib.request
from email import policy
from email.generator import BytesGenerator
from email.message import EmailMessage
from email.parser import BytesParser
from io import BytesIO

import Milter

API_URL = os.environ.get("SIGNATURE_MANAGER_URL", "https://mobiwave-signature-manager.vercel.app")
API_KEY = os.environ.get("SIGNATURE_GATEWAY_API_KEY", "")
ORGANIZATION_ID = os.environ.get("SIGNATURE_ORGANIZATION_ID", "")
SOCKET = os.environ.get("MILTER_SOCKET", "inet:10025@127.0.0.1")
TIMEOUT = float(os.environ.get("SIGNATURE_API_TIMEOUT", "4"))

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("mobiwave-signature-gateway")

START = b"<!-- MW_SIGNATURE_START -->"
END = b"<!-- MW_SIGNATURE_END -->"


def sender_address(value: str) -> str:
    value = value or ""
    match = re.search(r"<([^>]+)>", value)
    return (match.group(1) if match else value).strip().lower()


def message_type(msg: EmailMessage) -> str:
    if msg.get("In-Reply-To") or msg.get("References"):
        return "reply"
    subject = (msg.get("Subject") or "").lower()
    if subject.startswith("fw:") or subject.startswith("fwd:"):
        return "forward"
    return "new"


def extract_html(msg: EmailMessage) -> bytes:
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/html" and not part.is_attachment():
                try:
                    return part.get_payload(decode=True) or b""
                except Exception:
                    return b""
        return b""
    if msg.get_content_type() == "text/html":
        return msg.get_payload(decode=True) or b""
    return b""


def call_resolver(sender: str, kind: str, body_html: str) -> dict | None:
    if not API_KEY or not ORGANIZATION_ID:
        log.warning("gateway credentials are not configured; leaving message unchanged")
        return None
    payload = json.dumps({
        "organizationId": ORGANIZATION_ID,
        "sender": sender,
        "messageType": kind,
        "bodyHtml": body_html,
    }).encode()
    request = urllib.request.Request(
        API_URL.rstrip("/") + "/api/signatures/resolve",
        data=payload,
        method="POST",
        headers={
            "content-type": "application/json",
            "x-signature-gateway-key": API_KEY,
            "user-agent": "MobiWave-Signature-Gateway/1.0",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT, context=ssl.create_default_context()) as response:
            if response.status != 200:
                log.warning("resolver returned HTTP %s", response.status)
                return None
            return json.loads(response.read().decode())
    except Exception as exc:
        log.warning("signature API unavailable; fail-open: %s", exc)
        return None


def append_html_signature(html: bytes, signature: str) -> bytes:
    sig = signature.encode("utf-8")
    if START in html or END in html:
        return html
    lower = html.lower()
    pos = lower.rfind(b"</body>")
    if pos >= 0:
        return html[:pos] + b"<br>" + sig + html[pos:]
    return html + b"<br>" + sig


def append_plain_signature(text: str, signature: str) -> str:
    if "MW_SIGNATURE_START" in text or "MW_SIGNATURE_END" in text:
        return text
    plain = re.sub(r"<br\s*/?>", "\n", signature, flags=re.I)
    plain = re.sub(r"<[^>]+>", "", plain)
    plain = re.sub(r"\n{3,}", "\n\n", plain).strip()
    return text.rstrip() + "\n\n" + plain + "\n"


def mutate_message(raw_message: bytes, resolved: dict) -> bytes:
    """Return a complete mutated MIME message for internal processing."""
    msg = BytesParser(policy=policy.SMTP).parsebytes(raw_message)
    html_sig = resolved.get("html") or ""
    plain_sig = resolved.get("plainText") or ""
    if not html_sig:
        return raw_message

    if msg.is_multipart():
        html_part = None
        text_part = None
        for part in msg.walk():
            if part.is_multipart() or part.is_attachment():
                continue
            if part.get_content_type() == "text/html" and html_part is None:
                html_part = part
            elif part.get_content_type() == "text/plain" and text_part is None:
                text_part = part

        if html_part is not None:
            current = html_part.get_payload(decode=True) or b""
            charset = html_part.get_content_charset() or "utf-8"
            try:
                current_text = current.decode(charset, errors="replace")
            except LookupError:
                current_text = current.decode("utf-8", errors="replace")
            html_part.set_payload(append_html_signature(current_text.encode("utf-8"), html_sig).decode("utf-8"))
            html_part.set_charset("utf-8")

        if text_part is not None:
            current = text_part.get_payload(decode=True) or b""
            charset = text_part.get_content_charset() or "utf-8"
            try:
                current_text = current.decode(charset, errors="replace")
            except LookupError:
                current_text = current.decode("utf-8", errors="replace")
            text_part.set_payload(append_plain_signature(current_text, plain_sig or html_sig))
            text_part.set_charset("utf-8")

    elif msg.get_content_type() == "text/html":
        current = msg.get_payload(decode=True) or b""
        charset = msg.get_content_charset() or "utf-8"
        current_text = current.decode(charset, errors="replace")
        msg.set_payload(append_html_signature(current_text.encode("utf-8"), html_sig).decode("utf-8"))
        msg.set_charset("utf-8")
    else:
        current = msg.get_payload(decode=True) or b""
        charset = msg.get_content_charset() or "utf-8"
        current_text = current.decode(charset, errors="replace")
        msg.set_payload(append_plain_signature(current_text, plain_sig or html_sig))
        msg.set_charset("utf-8")

    output = BytesIO()
    BytesGenerator(output, policy=policy.SMTP).flatten(msg)
    return output.getvalue()


def build_message_from_milter_headers(headers: list[tuple[str, str]], body: bytes) -> bytes:
    """Reconstruct enough of the MIME message for Python's parser.

    Milter's body callback contains the message body, not the SMTP headers.
    Only headers needed for MIME parsing and message classification are retained.
    """
    wanted = {
        "content-type",
        "content-transfer-encoding",
        "mime-version",
        "in-reply-to",
        "references",
        "subject",
    }
    lines = []
    for name, value in headers:
        if name.lower() in wanted:
            lines.append(f"{name}: {value}\r\n".encode("utf-8", errors="replace"))
    return b"".join(lines) + b"\r\n" + body


def extract_body(serialized: bytes) -> bytes:
    separator = b"\r\n\r\n"
    index = serialized.find(separator)
    if index >= 0:
        return serialized[index + len(separator):]
    separator = b"\n\n"
    index = serialized.find(separator)
    if index >= 0:
        return serialized[index + len(separator):]
    return serialized


class SignatureMilter(Milter.Base):
    def __init__(self):
        self.chunks = []
        self.headers = []
        self.mail_from = ""

    def envfrom(self, *args):
        self.mail_from = sender_address(args[0] if args else "")
        return Milter.CONTINUE

    def header(self, name, value):
        self.headers.append((name, value))
        return Milter.CONTINUE

    def eoh(self):
        return Milter.CONTINUE

    def eom(self):
        body = b"".join(self.chunks)
        if not self.mail_from or not body:
            return Milter.CONTINUE
        try:
            raw = build_message_from_milter_headers(self.headers, body)
            original = BytesParser(policy=policy.SMTP).parsebytes(raw)
            html = extract_html(original)
            if START in html or END in html:
                return Milter.CONTINUE
            resolved = call_resolver(
                self.mail_from,
                message_type(original),
                html.decode("utf-8", errors="replace"),
            )
            if not resolved or not resolved.get("inject"):
                return Milter.CONTINUE
            updated = mutate_message(raw, resolved)
            # pymilter replacebody() replaces the message BODY only, not headers.
            self.replacebody(extract_body(updated))
        except Exception:
            log.exception("signature processing failed; fail-open")
        return Milter.CONTINUE

    def body(self, chunk):
        self.chunks.append(chunk)
        return Milter.CONTINUE

    def close(self):
        self.chunks = []
        self.headers = []
        self.mail_from = ""
        return Milter.CONTINUE


def main():
    if not ORGANIZATION_ID:
        log.warning("SIGNATURE_ORGANIZATION_ID is not configured; gateway will fail-open")
    Milter.factory = SignatureMilter
    Milter.set_flags(Milter.CHGBODY | Milter.ADDHDR | Milter.CHGHDRS)
    log.info("starting MobiWave signature gateway on %s", SOCKET)
    Milter.runmilter("mobiwave-signature", SOCKET, 300)


if __name__ == "__main__":
    main()
