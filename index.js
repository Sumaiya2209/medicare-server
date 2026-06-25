const express = require('express');
const cors = require('cors');
const cookieParser = require("cookie-parser");
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config();

const verifyToken = require("./middleware/verifyToken");
const verifyRole = require("./middleware/verifyRole");

const app = express();
const port = 5000;

app.use(express.json());
app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:3000",
  credentials: true,
}));
app.use(cookieParser());

app.get('/', (req, res) => {
  res.send('Hello World!')
});

const uri = process.env.MONGODB_URL;

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
    const appointmentsCollection = database.collection("appointments");
    const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
    const usersCollection = database.collection("user");

    const ADMIN_EMAIL = "jannatsumaiya199@gmail.com";

    const existingAdmin = await usersCollection.findOne({ email: ADMIN_EMAIL });
    if (existingAdmin && existingAdmin.role !== "admin") {
      await usersCollection.updateOne(
        { email: ADMIN_EMAIL },
        { $set: { role: "admin" } }
      );
      console.log(`✅ Admin role set for ${ADMIN_EMAIL}`);
    } else if (existingAdmin) {
      console.log(`✅ Admin already set: ${ADMIN_EMAIL}`);
    } else {
      console.log(`⚠️ Admin email not found in DB: ${ADMIN_EMAIL}`);
    }


    // Featured doctors (verified only, limit 6)
    app.get("/api/home/featured-doctors", async (req, res) => {
      try {
        const doctors = await doctorsCollection
          .find({ verificationStatus: "verified" })
          .limit(6)
          .toArray();
        res.send(doctors);
      } catch (err) {
        res.status(500).send({ message: "Failed" });
      }
    });

    // Platform statistics
    app.get("/api/home/stats", async (req, res) => {
      try {
        const usersCollection = database.collection("user");
        const reviewsCollection = database.collection("reviews");

        const totalDoctors = await doctorsCollection.countDocuments({ verificationStatus: "verified" });
        const totalPatients = await usersCollection.countDocuments({ role: "patient" });
        const totalAppointments = await appointmentsCollection.countDocuments();
        const totalReviews = await reviewsCollection.countDocuments();

        res.send({ totalDoctors, totalPatients, totalAppointments, totalReviews });
      } catch (err) {
        res.status(500).send({ message: "Failed" });
      }
    });
    // Patient testimonials (reviews with patient info)
    app.get("/api/home/testimonials", async (req, res) => {
      try {
        const reviewsCollection = database.collection("reviews");
        const usersCollection = database.collection("user");

        const reviews = await reviewsCollection
          .aggregate([
            {
              $addFields: {
                patientObjId: { $toObjectId: "$patientId" },
                doctorObjId: { $toObjectId: "$doctorId" },
              },
            },
            {
              $lookup: {
                from: "user",
                localField: "patientObjId",
                foreignField: "_id",
                as: "patientInfo",
              },
            },
            {
              $lookup: {
                from: "doctor",
                localField: "doctorObjId",
                foreignField: "_id",
                as: "doctorInfo",
              },
            },
            { $unwind: { path: "$patientInfo", preserveNullAndEmptyArrays: true } },
            { $unwind: { path: "$doctorInfo", preserveNullAndEmptyArrays: true } },
            { $sort: { createdAt: -1 } },
            { $limit: 6 },
          ])
          .toArray();

        res.send(reviews);
      } catch (err) {
        res.status(500).send({ message: "Failed" });
      }
    });

    // ─── DOCTORS ────────────────────────────────────────────

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

    app.get("/api/doctors/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const doctor = await doctorsCollection.findOne({ _id: new ObjectId(id) });

        if (!doctor) {
          return res.status(404).send({ message: "Doctor not found" });
        }

        res.send(doctor);
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Failed to fetch doctor" });
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

    // ─── APPOINTMENTS ────────────────────────────────────────

    app.post("/api/appointments", verifyToken, async (req, res) => {
      try {
        const appointmentData = req.body;

        if (
          !appointmentData.patientId ||
          !appointmentData.doctorId ||
          !appointmentData.appointmentDate ||
          !appointmentData.appointmentTime
        ) {
          return res.status(400).send({ message: "Required fields missing" });
        }

        const existing = await appointmentsCollection.findOne({
          doctorId: appointmentData.doctorId,
          appointmentDate: appointmentData.appointmentDate,
          appointmentTime: appointmentData.appointmentTime,
          appointmentStatus: { $ne: "cancelled" },
        });

        if (existing) {
          return res.status(409).send({ message: "This time slot is already booked." });
        }

        const newAppointment = {
          ...appointmentData,
          appointmentStatus: "pending",
          paymentStatus: "unpaid",
          createdAt: new Date(),
        };

        const result = await appointmentsCollection.insertOne(newAppointment);
        res.status(201).send(result);
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Failed to book appointment" });
      }
    });

    app.get("/api/appointments/patient/:patientId", verifyToken, async (req, res) => {
      try {
        const { patientId } = req.params;

        const appointments = await appointmentsCollection
          .aggregate([
            { $match: { patientId } },
            {
              $addFields: {
                doctorObjId: { $toObjectId: "$doctorId" },
              },
            },
            {
              $lookup: {
                from: "doctor",
                localField: "doctorObjId",
                foreignField: "_id",
                as: "doctorInfo",
              },
            },
            { $unwind: { path: "$doctorInfo", preserveNullAndEmptyArrays: true } },
            { $sort: { appointmentDate: 1, appointmentTime: 1 } },
          ])
          .toArray();

        res.send(appointments);
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Failed to fetch patient appointments" });
      }
    });


    // Payment intent create
    app.post("/api/payments/create-intent", verifyToken, async (req, res) => {
      try {
        const { appointmentId, amount } = req.body;

        if (!appointmentId || !amount) {
          return res.status(400).send({ message: "appointmentId and amount required" });
        }

        const paymentIntent = await stripe.paymentIntents.create({
          amount: Math.round(amount * 100), // cent e convert (50$ = 5000 cents)
          currency: "usd",
          metadata: { appointmentId },
        });

        res.send({ clientSecret: paymentIntent.client_secret });
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Failed to create payment intent" });
      }
    });

    // Payment success hole appointment update
    app.patch("/api/appointments/:id/payment", verifyToken, async (req, res) => {
      try {
        const { transactionId } = req.body;
        const appointmentId = req.params.id;

        const result = await appointmentsCollection.updateOne(
          { _id: new ObjectId(appointmentId) },
          {
            $set: {
              paymentStatus: "paid",
              appointmentStatus: "confirmed",
              transactionId,
              paidAt: new Date(),
            },
          }
        );

        res.send(result);
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Failed to update payment" });
      }
    });

    app.get("/api/appointments/:id", verifyToken, async (req, res) => {
      try {
        const appointment = await appointmentsCollection
          .aggregate([
            { $match: { _id: new ObjectId(req.params.id) } },
            {
              $addFields: { doctorObjId: { $toObjectId: "$doctorId" } },
            },
            {
              $lookup: {
                from: "doctor",
                localField: "doctorObjId",
                foreignField: "_id",
                as: "doctorInfo",
              },
            },
            { $unwind: { path: "$doctorInfo", preserveNullAndEmptyArrays: true } },
          ])
          .toArray();

        if (!appointment[0]) {
          return res.status(404).send({ message: "Appointment not found" });
        }

        res.send(appointment[0]);
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Failed to fetch appointment" });
      }
    });

    // Cancel appointment
    app.patch("/api/appointments/:id/cancel", verifyToken, async (req, res) => {
      try {
        const result = await appointmentsCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { appointmentStatus: "cancelled", updatedAt: new Date() } }
        );
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to cancel appointment" });
      }
    });

    // Reschedule appointment
    app.patch("/api/appointments/:id/reschedule", verifyToken, async (req, res) => {
      try {
        const { appointmentDate, appointmentTime } = req.body;

        if (!appointmentDate || !appointmentTime) {
          return res.status(400).send({ message: "Date and time required" });
        }

        const result = await appointmentsCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          {
            $set: {
              appointmentDate,
              appointmentTime,
              appointmentStatus: "pending",
              updatedAt: new Date(),
            },
          }
        );
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to reschedule" });
      }
    });

    // ─── ADMIN ROUTES ────────────────────────────────────────

    app.delete("/api/users/:id", verifyToken, verifyRole("admin"), async (req, res) => {
      try {
        const usersCollection = database.collection("user");
        const result = await usersCollection.deleteOne({ _id: new ObjectId(req.params.id) });
        res.send(result);
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Failed to delete user" });
      }
    });

    app.patch("/api/doctors/:id/verify", verifyToken, verifyRole("admin"), async (req, res) => {
      try {
        const { status } = req.body;
        const result = await doctorsCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { verificationStatus: status } }
        );
        res.send(result);
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Failed to update doctor status" });
      }
    });

    app.get("/api/payments/patient/:patientId", verifyToken, async (req, res) => {
      try {
        const { patientId } = req.params;

        const payments = await appointmentsCollection
          .aggregate([
            {
              $match: {
                patientId,
                paymentStatus: "paid",
              },
            },
            {
              $addFields: {
                doctorObjId: { $toObjectId: "$doctorId" },
              },
            },
            {
              $lookup: {
                from: "doctor",
                localField: "doctorObjId",
                foreignField: "_id",
                as: "doctorInfo",
              },
            },
            {
              $unwind: {
                path: "$doctorInfo",
                preserveNullAndEmptyArrays: true,
              },
            },
            { $sort: { paidAt: -1 } },
          ])
          .toArray();

        res.send(payments);
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Failed to fetch payment history" });
      }
    });


    // Doctor er shob appointments (pending/confirmed/etc)
    app.get("/api/appointments/doctor/:doctorId", verifyToken, async (req, res) => {
      try {
        const { doctorId } = req.params;

        const appointments = await appointmentsCollection
          .aggregate([
            { $match: { doctorId } },
            {
              $addFields: {
                patientObjId: { $toObjectId: "$patientId" },
              },
            },
            {
              $lookup: {
                from: "user",
                localField: "patientObjId",
                foreignField: "_id",
                as: "patientInfo",
              },
            },
            {
              $unwind: {
                path: "$patientInfo",
                preserveNullAndEmptyArrays: true,
              },
            },
            { $sort: { appointmentDate: 1, appointmentTime: 1 } },
          ])
          .toArray();

        res.send(appointments);
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Failed to fetch doctor appointments" });
      }
    });

    // Appointment status update (accept/reject/complete)
    app.patch("/api/appointments/:id/status", verifyToken, async (req, res) => {
      try {
        const { status } = req.body;
        const validStatuses = ["confirmed", "cancelled", "completed", "pending"];

        if (!validStatuses.includes(status)) {
          return res.status(400).send({ message: "Invalid status" });
        }

        const result = await appointmentsCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { appointmentStatus: status, updatedAt: new Date() } }
        );

        res.send(result);
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Failed to update appointment status" });
      }
    });

    app.get("/api/doctors/user/:userId", verifyToken, async (req, res) => {
      try {
        const doctor = await doctorsCollection.findOne({
          userId: req.params.userId,
        });

        if (!doctor) {
          return res.status(404).send({ message: "Doctor profile not found" });
        }

        res.send(doctor);
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Failed to fetch doctor" });
      }
    });


    // ─── ADMIN: USERS ────────────────────────────────────────

    // All users fetch
    app.get("/api/admin/users", verifyToken, verifyRole("admin"), async (req, res) => {
      try {
        const users = await usersCollection.find({}).toArray();
        res.send(users);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch users" });
      }
    });

    // Delete user
    app.delete("/api/admin/users/:id", verifyToken, verifyRole("admin"), async (req, res) => {
      try {
        const result = await usersCollection.deleteOne({
          _id: new ObjectId(req.params.id),
        });
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to delete user" });
      }
    });

    // Suspend/activate user
    app.patch("/api/admin/users/:id/status", verifyToken, verifyRole("admin"), async (req, res) => {
      try {
        const { status } = req.body;
        const result = await usersCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { status } }
        );
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to update user status" });
      }
    });

    // ─── ADMIN: DOCTORS ──────────────────────────────────────

    // All doctors
    app.get("/api/admin/doctors", verifyToken, verifyRole("admin"), async (req, res) => {
      try {
        const doctors = await doctorsCollection.find({}).toArray();
        res.send(doctors);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch doctors" });
      }
    });

    // Verify/reject doctor
    app.patch("/api/admin/doctors/:id/verify", verifyToken, verifyRole("admin"), async (req, res) => {
      try {
        const { verificationStatus } = req.body;
        const result = await doctorsCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { verificationStatus } }
        );
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to update doctor status" });
      }
    });

    // ─── ADMIN: ANALYTICS ────────────────────────────────────

    app.get("/api/admin/analytics", verifyToken, verifyRole("admin"), async (req, res) => {
      try {
        const totalDoctors = await doctorsCollection.countDocuments();
        const totalPatients = await usersCollection.countDocuments({ role: "patient" });
        const totalAppointments = await appointmentsCollection.countDocuments();
        const totalPaid = await appointmentsCollection.countDocuments({ paymentStatus: "paid" });

        // Doctor performance (rating based)
        const doctorPerformance = await doctorsCollection
          .find({}, { projection: { doctorName: 1, rating: 1, specialization: 1 } })
          .sort({ rating: -1 })
          .limit(5)
          .toArray();

        // Monthly appointments
        const monthlyData = await appointmentsCollection
          .aggregate([
            {
              $group: {
                _id: { $substr: ["$appointmentDate", 0, 7] },
                count: { $sum: 1 },
              },
            },
            { $sort: { _id: 1 } },
            { $limit: 6 },
          ])
          .toArray();

        res.send({
          totalDoctors,
          totalPatients,
          totalAppointments,
          totalPaid,
          doctorPerformance,
          monthlyData,
        });
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch analytics" });
      }
    });

    // All appointments (admin)
    app.get("/api/admin/appointments", verifyToken, verifyRole("admin"), async (req, res) => {
      try {
        const appointments = await appointmentsCollection
          .aggregate([
            {
              $addFields: {
                doctorObjId: { $toObjectId: "$doctorId" },
                patientObjId: { $toObjectId: "$patientId" },
              },
            },
            {
              $lookup: {
                from: "doctor",
                localField: "doctorObjId",
                foreignField: "_id",
                as: "doctorInfo",
              },
            },
            {
              $lookup: {
                from: "user",
                localField: "patientObjId",
                foreignField: "_id",
                as: "patientInfo",
              },
            },
            { $unwind: { path: "$doctorInfo", preserveNullAndEmptyArrays: true } },
            { $unwind: { path: "$patientInfo", preserveNullAndEmptyArrays: true } },
            { $sort: { createdAt: -1 } },
          ])
          .toArray();

        res.send(appointments);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch appointments" });
      }
    });

    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");

  } catch (error) {
    console.error(error);
  }
}

run().catch(console.dir);

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
});