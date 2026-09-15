export const config = {
  runtime: 'nodejs',
};

let appPromise: Promise<any> | undefined;

async function loadApp() {
  appPromise ??= import('../backend/src/app.js').then((module) => module.default);
  return appPromise;
}

export default async function handler(req: any, res: any) {
  try {
    const app = await loadApp();
    return app(req, res);
  } catch (error) {
    console.error('[api] Unhandled request error', error);

    if (!res.headersSent) {
      return res.status(500).json({
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'production' ? undefined : String(error),
      });
    }
  }
}
