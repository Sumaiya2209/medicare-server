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
    const doctorsCollection = database.collection("doctor");

    app.get("/api/doctors", async (req, res) => {
      try {
        const {
          search = "",
          specialization = "",
          sort = "fee-asc",
          page = 1,
          limit = 8,
        } = req.query;

        const query = {};

        if (search.trim()) {
          query.doctorName = { $regex: search, $options: "i" };
        }

        if (specialization && specialization !== "All Specializations") {
          query.specialization = { $regex: `^${specialization}$`, $options: "i" };
        }

        let sortQuery = {};
        if (sort === "fee-asc") sortQuery = { consultationFee: 1 };
        else if (sort === "fee-desc") sortQuery = { consultationFee: -1 };
        else if (sort === "rating-desc") sortQuery = { rating: -1 };
        else if (sort === "experience-desc") sortQuery = { experience: -1 };

        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);

        const totalCount = await doctorsCollection.countDocuments(query);

        const doctors = await doctorsCollection
          .find(query)
          .sort(sortQuery)
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
        res.status(500).send({ message: "Failed to fetch doctors" });
      }
    });

    app.post("/api/doctors", async (req, res) => {
      try {
        const doctorData = req.body;

        if (!doctorData.doctorName || !doctorData.specialization || !doctorData.userId) {
          return res.status(400).send({ message: "Required fields missing" });
        }

        const result = await doctorsCollection.insertOne(doctorData);
        res.status(201).send(result);
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Failed to create doctor profile" });
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