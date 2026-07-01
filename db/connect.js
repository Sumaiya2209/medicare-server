const { MongoClient } = require("mongodb");

let cached = global.__mongoClientCache || { client: null, conn: null };

async function connectDB() {
  if (cached.conn) {
    console.log("[db] using cached connection");
    return cached.conn;
  }

  const uri = process.env.MONGODB_URI || process.env.MONGODB_URL;
  if (!uri) {
    throw new Error("MONGODB_URI is not configured");
  }

  console.log("[db] creating new connection");

  // Create MongoClient without deprecated options. Newer drivers ignore
  // `useNewUrlParser` / `useUnifiedTopology` and will throw if passed.
  const client = new MongoClient(uri);

  cached.client = client;
  try {
    await client.connect();
  } catch (err) {
    console.error("Failed to connect to database:", err);
    // Rethrow so callers can handle shutdown/logging
    throw err;
  }

  const db = client.db(process.env.MONGODB_DBNAME || "medicare_connect");
  cached.conn = { client, db };
  global.__mongoClientCache = cached;

  console.log("[db] connected");
  return cached.conn;
}

module.exports = connectDB;
