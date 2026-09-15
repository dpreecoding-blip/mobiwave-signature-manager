import app from '../backend/src/app.js';

export const config = {
  runtime: 'nodejs',
};

export default async function handler(req: any, res: any) {
  try {
    await app(req, res);
  } catch (error) {
    console.error('[api] Unhandled request error', error);

    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}
