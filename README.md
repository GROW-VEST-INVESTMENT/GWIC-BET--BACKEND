# GWIC BET backend

## Run locally

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env` and set `MONGODB_URI` to the Atlas connection
   string. Keep `.env` private; it is ignored by Git.
3. Keep `CLIENT_URL` set to `http://localhost:5173` for local Vite development.
4. Start the server with `npm run dev`. The health endpoint is
   `http://localhost:5000/api/health`.

## Deploy to Render

- Create a Web Service for this repository.
- Set the build command to `npm install` and the start command to `npm start`.
- Set the health check path to `/api/health`.
- Add these environment variables in Render:
  - `MONGODB_URI`: your MongoDB Atlas connection string.
  - `CLIENT_URL`: the exact Vercel site origin, including `https://`, for
    example `https://your-project.vercel.app`. Multiple allowed origins can
    be comma-separated.
  - `NODE_ENV`: `production` (recommended).
- Render supplies `PORT`; do not hardcode a production port.

The health endpoint reports success only when MongoDB responds to a ping.
Never add database credentials to frontend or `VITE_` variables.
