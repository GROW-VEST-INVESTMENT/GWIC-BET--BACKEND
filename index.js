require('dotenv').config();

const cors = require('cors');
const express = require('express');
const { MongoClient } = require('mongodb');

const app = express();
const port = process.env.PORT || 5000;
const mongoClient = process.env.MONGODB_URI
  ? new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 })
  : null;

const allowedOrigins = (process.env.CLIENT_URL || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error(`Origin ${origin} is not allowed by CORS`));
  },
}));
app.use(express.json());

app.get('/api/health', async (req, res) => {
  if (!mongoClient) {
    return res.status(503).json({ status: 'error', database: 'not configured' });
  }

  try {
    await mongoClient.db('admin').command({ ping: 1 });
    return res.json({ status: 'ok', database: 'connected' });
  } catch (error) {
    console.error(`MongoDB health check failed (${error.name})`);
    return res.status(503).json({ status: 'error', database: 'disconnected' });
  }
});

app.listen(port, () => {
  console.log(`API server listening on port ${port}`);
});

if (mongoClient) {
  mongoClient.connect()
    .then(() => console.log('MongoDB connected successfully'))
    .catch((error) => console.error(`MongoDB connection failed (${error.name})`));
}
