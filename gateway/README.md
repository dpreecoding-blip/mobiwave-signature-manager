# MobiWave Signature Gateway

This gateway runs beside the existing MobiWave mail server. It is a Postfix Milter and is deliberately separate from the Vercel control plane.

## Flow

`Roundcube -> Postfix -> MobiWave Milter -> DKIM -> delivery`

The milter sends only the sender, message type, and HTML body to the Signature Manager resolver. The API returns the selected signature. The gateway modifies the MIME message in memory and never stores the message body.

If the API is unavailable, authentication fails, the signature is missing, or processing raises an exception, the message is accepted unchanged (**fail-open**).

## Install

```bash
sudo apt update
sudo apt install -y python3 python3-pip python3-venv
sudo useradd --system --no-create-home --shell /usr/sbin/nologin milter || true
sudo mkdir -p /opt/mobiwave-signature-manager
sudo cp -R gateway /opt/mobiwave-signature-manager/
cd /opt/mobiwave-signature-manager/gateway
sudo python3 -m venv .venv
sudo .venv/bin/pip install -r requirements.txt
```

Create `/etc/mobiwave-signature-gateway.env` and keep it root-readable:

```env
SIGNATURE_MANAGER_URL=https://mobiwave-signature-manager.vercel.app
SIGNATURE_GATEWAY_API_KEY=<same-secret-configured-in-vercel>
SIGNATURE_ORGANIZATION_ID=92423948-23b9-4cfe-89c2-32e37315fec4
MILTER_SOCKET=inet:10025@127.0.0.1
SIGNATURE_API_TIMEOUT=4
LOG_LEVEL=INFO
```

Then:

```bash
sudo cp mobiwave-signature-gateway.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mobiwave-signature-gateway
sudo systemctl status mobiwave-signature-gateway
```

## Postfix integration

Configure Postfix to connect to the milter on localhost port 10025. The exact parameter names depend on the current Postfix configuration, but the target is:

```text
inet:127.0.0.1:10025
```

The signature gateway must execute **before DKIM signing**. Do not point SMTP delivery itself at Vercel.

After changing Postfix configuration, validate it with `postfix check` and restart/reload Postfix. Keep the milter disabled for production mail until the test message has been inspected for:

- HTML signature present once
- plain-text alternative present
- attachments unchanged
- Reply/Forward policy respected
- DKIM passes after signing
- SPF/DMARC remain normal

## Safety

- No SMTP credentials are stored by the Signature Manager.
- No complete email body is persisted by the gateway or resolver.
- Duplicate markers prevent double injection.
- API timeout is short so the mail path is not blocked unnecessarily.
- Resolver/API failure is fail-open.
- Keep `SIGNATURE_GATEWAY_API_KEY` out of Git.
