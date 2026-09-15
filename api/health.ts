export const config = {
  runtime: 'nodejs',
};

export default function handler(req: any, res: any) {
  res.status(200).json({
    ok: true,
    service: 'mobiwave-signature-manager',
    function: 'health',
    databaseConfigured: Boolean(process.env.DATABASE_URL),
    gatewayKeyConfigured: Boolean(process.env.SIGNATURE_GATEWAY_API_KEY),
    time: new Date().toISOString(),
  });
}
