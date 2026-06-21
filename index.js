const express = require('express');
const cors = require('cors');
const app = express()
const port = 5000
const { MongoClient, ServerApiVersion } = require('mongodb');
require('dotenv').config();

app.use(express.json());
app.use(cors());

app.get('/', (req, res) => {
  res.send('Hello World!')
})

const uri = process.env.MONGODB_URL;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {
    await client.connect();

    const database = client.db("medicare_connect");
    const usersCollection = database.collection("user");



    app.get("/api/doctors", async (req, res) => {
      try {
        const {
          search = "",
          page = 1,
          limit = 8,
        } = req.query;

        const query = {
          role: "doctor",
        };

        if (search.trim()) {
          query.name = {
            $regex: search,
            $options: "i",
          };
        }

        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);

        const totalCount = await usersCollection.countDocuments(query);

        const doctors = await usersCollection
          .find(query)
          .skip((pageNum - 1) * limitNum)
          .limit(limitNum)
          .toArray();

        res.send({
          doctors,
          totalCount,
          totalPages: Math.ceil(totalCount / limitNum),
          currentPage: pageNum,
        });
      } catch (error) {
        console.error(error);
        res.status(500).send({
          message: "Failed to fetch doctors",
        });
      }
    });

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } catch (error) {
    console.error(error);
  }
}

run().catch(console.dir);



app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})