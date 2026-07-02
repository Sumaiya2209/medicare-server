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
const allowedOrigins = [
  "http://localhost:3000",
  ...(process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(",").map((origin) => origin.trim()).filter(Boolean) : []),
];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS policy blocked origin: ${origin}`));
  },
  credentials: true,
}));
app.use(cookieParser());

app.get('/', (req, res) => {
  res.send('Hello World - Updated at ' + new Date().toISOString())
});

const connectDB = require("./db/connect");
let _db = null;
let stripe = null;

async function getDb() {
  if (_db) return _db;
  const { db } = await connectDB();
  _db = db;
  return db;
}

async function doctorsCollection() {
  const db = await getDb();
  return db.collection("doctor");
}
async function appointmentsCollection() {
  const db = await getDb();
  return db.collection("appointments");
}
async function usersCollection() {
  const db = await getDb();
  return db.collection("user");
}
async function reviewsCollection() {
  const db = await getDb();
  return db.collection("reviews");
}
async function prescriptionsCollection() {
  const db = await getDb();
  return db.collection("prescriptions");
}
function getStripe() {
  if (!stripe) stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
  return stripe;
}

const ADMIN_EMAIL = "jannatsumaiya199@gmail.com";

async function createAdmin() {
  const existingAdmin = await (await usersCollection()).findOne({
    email: ADMIN_EMAIL,
  });

  if (existingAdmin && existingAdmin.role !== "admin") {
    await (await usersCollection()).updateOne(
      { email: ADMIN_EMAIL },
      { $set: { role: "admin" } }
    );
    console.log(`✅ Admin role set for ${ADMIN_EMAIL}`);
  } else if (existingAdmin) {
    console.log(`✅ Admin already set: ${ADMIN_EMAIL}`);
  } else {
    console.log(`⚠️ Admin email not found in DB: ${ADMIN_EMAIL}`);
  }
}


// Featured doctors (verified only, limit 6)
app.get("/api/home/featured-doctors", async (req, res) => {
  try {
    const doctors = await (await doctorsCollection())
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
    // Ensure collections are available
    const totalDoctors = (await (await doctorsCollection())?.countDocuments?.({ verificationStatus: "verified" })) || 0;
    const totalPatients = (await (await usersCollection())?.countDocuments?.({ role: "patient" })) || 0;
    const totalAppointments = (await (await appointmentsCollection())?.countDocuments?.()) || 0;
    const totalReviews = (await (await reviewsCollection())?.countDocuments?.()) || 0;

    res.send({ doctors: totalDoctors, patients: totalPatients, appointments: totalAppointments, reviews: totalReviews });
  } catch (err) {
    console.error("/api/home/stats error:", err);
    res.status(200).send({ doctors: 0, patients: 0, appointments: 0, reviews: 0 });
  }
});
// Patient testimonials (reviews with patient info)
app.get("/api/home/testimonials", async (req, res) => {
  try {
    console.log("DEBUG: Starting testimonials query...");
    if (!reviewsCollection) {
      console.log("DEBUG: reviewsCollection is undefined!");
      return res.status(500).send({ message: "Failed", error: "reviewsCollection is undefined" });
    }
    const reviews = await (await reviewsCollection())
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

    console.log("DEBUG: Query successful, sending", reviews.length, "reviews");
    res.send(reviews);
  } catch (err) {
    console.error("Testimonials endpoint error:", err);
    res.status(500).send({ message: "Failed", error: err.message, errorType: err.name });
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

    const totalCount = await (await doctorsCollection()).countDocuments(query);

    const doctors = await (await doctorsCollection())
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
    const doctor = await (await doctorsCollection()).findOne({ _id: new ObjectId(id) });

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

    const result = await (await doctorsCollection()).insertOne(doctorData);
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

    const existing = await (await appointmentsCollection()).findOne({
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

    const result = await (await appointmentsCollection()).insertOne(newAppointment);
    res.status(201).send(result);
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Failed to book appointment" });
  }
});

app.get("/api/appointments/patient/:patientId", verifyToken, async (req, res) => {
  try {
    const { patientId } = req.params;

    const appointments = await (await appointmentsCollection())
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

    const paymentIntent = await getStripe().paymentIntents.create({
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

    const result = await (await appointmentsCollection()).updateOne(
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
    const appointment = await (await appointmentsCollection())
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
    const result = await (await appointmentsCollection()).updateOne(
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

    const result = await (await appointmentsCollection()).updateOne(
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
    const result = await (await usersCollection()).deleteOne({ _id: new ObjectId(req.params.id) });
    res.send(result);
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Failed to delete user" });
  }
});

app.patch("/api/doctors/:id/verify", verifyToken, verifyRole("admin"), async (req, res) => {
  try {
    const { status } = req.body;
    const result = await (await doctorsCollection()).updateOne(
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

    const payments = await (await appointmentsCollection())
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

    const appointments = await (await appointmentsCollection())
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

    const result = await (await appointmentsCollection()).updateOne(
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
    const doctor = await (await doctorsCollection()).findOne({
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
    const users = await (await usersCollection()).find({}).toArray();
    res.send(users);
  } catch (err) {
    res.status(500).send({ message: "Failed to fetch users" });
  }
});

// Delete user
app.delete("/api/admin/users/:id", verifyToken, verifyRole("admin"), async (req, res) => {
  try {
    const result = await (await usersCollection()).deleteOne({
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
    const result = await (await usersCollection()).updateOne(
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
    const doctors = await (await doctorsCollection()).find({}).toArray();
    res.send(doctors);
  } catch (err) {
    res.status(500).send({ message: "Failed to fetch doctors" });
  }
});

// Verify/reject doctor
app.patch("/api/admin/doctors/:id/verify", verifyToken, verifyRole("admin"), async (req, res) => {
  try {
    const { verificationStatus } = req.body;
    const result = await (await doctorsCollection()).updateOne(
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
    const totalDoctors = await (await doctorsCollection()).countDocuments();
    const totalPatients = await (await usersCollection()).countDocuments({ role: "patient" });
    const totalAppointments = await (await appointmentsCollection()).countDocuments();
    const totalPaid = await (await appointmentsCollection()).countDocuments({ paymentStatus: "paid" });

    // Doctor performance (rating based)
    const doctorPerformance = await (await doctorsCollection())
      .find({}, { projection: { doctorName: 1, rating: 1, specialization: 1 } })
      .sort({ rating: -1 })
      .limit(5)
      .toArray();

    // Monthly appointments
    const monthlyData = await (await appointmentsCollection())
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
    const appointments = await (await appointmentsCollection())
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


// Get patient reviews
app.get("/api/reviews/patient/:patientId", verifyToken, async (req, res) => {
  try {
    const reviews = await (await reviewsCollection())
      .aggregate([
        { $match: { patientId: req.params.patientId } },
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
        { $sort: { createdAt: -1 } },
      ])
      .toArray();

    res.send(reviews);
  } catch (err) {
    res.status(500).send({ message: "Failed to fetch reviews" });
  }
});

// Add review
app.post("/api/reviews", verifyToken, async (req, res) => {
  try {
    const { patientId, doctorId, rating, reviewText } = req.body;

    if (!patientId || !doctorId || !rating || !reviewText) {
      return res.status(400).send({ message: "All fields required" });
    }

    // Ek doctor ke ekbar er beshi review dewa jacche kina check
    const existing = await (await reviewsCollection()).findOne({ patientId, doctorId });
    if (existing) {
      return res.status(409).send({ message: "You already reviewed this doctor" });
    }

    const result = await (await reviewsCollection()).insertOne({
      patientId,
      doctorId,
      rating: Number(rating),
      reviewText,
      createdAt: new Date(),
    });

    res.status(201).send(result);
  } catch (err) {
    res.status(500).send({ message: "Failed to add review" });
  }
});

// Update review
app.patch("/api/reviews/:id", verifyToken, async (req, res) => {
  try {
    const { rating, reviewText } = req.body;
    const result = await (await reviewsCollection()).updateOne(
      { _id: new ObjectId(req.params.id) },
      {
        $set: {
          rating: Number(rating),
          reviewText,
          updatedAt: new Date(),
        },
      }
    );
    res.send(result);
  } catch (err) {
    res.status(500).send({ message: "Failed to update review" });
  }
});

// Delete review
app.delete("/api/reviews/:id", verifyToken, async (req, res) => {
  try {
    const result = await (await reviewsCollection()).deleteOne({
      _id: new ObjectId(req.params.id),
    });
    res.send(result);
  } catch (err) {
    res.status(500).send({ message: "Failed to delete review" });
  }
});

// Get doctor profile by userId
// Already ache: GET /api/doctors/user/:userId

// Update doctor profile
app.patch("/api/doctors/user/:userId", verifyToken, async (req, res) => {
  try {
    const { qualifications, experience, consultationFee, availableSlots, availableDays, hospitalName, specialization } = req.body;

    const result = await (await doctorsCollection()).updateOne(
      { userId: req.params.userId },
      {
        $set: {
          qualifications,
          experience: Number(experience),
          consultationFee: Number(consultationFee),
          availableSlots,
          availableDays,
          hospitalName,
          specialization,
          updatedAt: new Date(),
        },
      }
    );

    res.send(result);
  } catch (err) {
    res.status(500).send({ message: "Failed to update profile" });
  }
});

// Specific date e doctor er booked slots fetch koro
app.get("/api/appointments/booked-slots", async (req, res) => {
  try {
    const { doctorId, date } = req.query;

    if (!doctorId || !date) {
      return res.status(400).send({ message: "doctorId and date required" });
    }

    const bookedAppointments = await (await appointmentsCollection())
      .find({
        doctorId,
        appointmentDate: date,
        appointmentStatus: { $ne: "cancelled" },
      })
      .project({ appointmentTime: 1 })
      .toArray();

    const bookedSlots = bookedAppointments.map((a) => a.appointmentTime);
    res.send(bookedSlots);
  } catch (err) {
    res.status(500).send({ message: "Failed to fetch booked slots" });
  }
});

// Get doctor schedule
app.get("/api/doctors/user/:userId/schedule", verifyToken, async (req, res) => {
  try {
    const doctor = await (await doctorsCollection()).findOne({ userId: req.params.userId });
    if (!doctor) return res.status(404).send({ message: "Doctor not found" });

    res.send({
      availableDays: doctor.availableDays || [],
      availableSlots: doctor.availableSlots || [],
    });
  } catch (err) {
    res.status(500).send({ message: "Failed to fetch schedule" });
  }
});

// Update schedule (days + slots)
app.patch("/api/doctors/user/:userId/schedule", verifyToken, async (req, res) => {
  try {
    const { availableDays, availableSlots } = req.body;

    const result = await (await doctorsCollection()).updateOne(
      { userId: req.params.userId },
      {
        $set: {
          availableDays,
          availableSlots,
          updatedAt: new Date(),
        },
      }
    );
    res.send(result);
  } catch (err) {
    res.status(500).send({ message: "Failed to update schedule" });
  }
});


// Get prescriptions by doctor
app.get("/api/prescriptions/doctor/:doctorId", verifyToken, async (req, res) => {
  try {
    const prescriptions = await (await prescriptionsCollection())
      .aggregate([
        { $match: { doctorId: req.params.doctorId } },
        {
          $addFields: {
            patientObjId: { $toObjectId: "$patientId" },
            appointmentObjId: { $toObjectId: "$appointmentId" },
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
            from: "appointments",
            localField: "appointmentObjId",
            foreignField: "_id",
            as: "appointmentInfo",
          },
        },
        { $unwind: { path: "$patientInfo", preserveNullAndEmptyArrays: true } },
        { $unwind: { path: "$appointmentInfo", preserveNullAndEmptyArrays: true } },
        { $sort: { createdAt: -1 } },
      ])
      .toArray();

    res.send(prescriptions);
  } catch (err) {
    res.status(500).send({ message: "Failed to fetch prescriptions" });
  }
});

// Create prescription
app.post("/api/prescriptions", verifyToken, async (req, res) => {
  try {
    const { doctorId, patientId, appointmentId, diagnosis, medications, notes } = req.body;

    if (!doctorId || !patientId || !appointmentId || !diagnosis) {
      return res.status(400).send({ message: "Required fields missing" });
    }

    const result = await (await prescriptionsCollection()).insertOne({
      doctorId,
      patientId,
      appointmentId,
      diagnosis,
      medications,
      notes,
      createdAt: new Date(),
    });

    res.status(201).send(result);
  } catch (err) {
    res.status(500).send({ message: "Failed to create prescription" });
  }
});

// Update prescription
app.patch("/api/prescriptions/:id", verifyToken, async (req, res) => {
  try {
    const { diagnosis, medications, notes } = req.body;

    const result = await (await prescriptionsCollection()).updateOne(
      { _id: new ObjectId(req.params.id) },
      {
        $set: {
          diagnosis,
          medications,
          notes,
          updatedAt: new Date(),
        },
      }
    );
    res.send(result);
  } catch (err) {
    res.status(500).send({ message: "Failed to update prescription" });
  }
});

// Get single prescription by appointmentId
app.get("/api/prescriptions/appointment/:appointmentId", verifyToken, async (req, res) => {
  try {
    const prescription = await (await prescriptionsCollection()).findOne({
      appointmentId: req.params.appointmentId,
    });
    res.send(prescription || null);
  } catch (err) {
    res.status(500).send({ message: "Failed to fetch prescription" });
  }
});


// Initialize DB and start server (only when run directly, not on Vercel)
if (require.main === module) {
  connectDB()
    .then(() => {
      // Create admin if needed (call asynchronously)
      createAdmin().catch((err) => console.error("createAdmin error:", err));

      app.listen(port, () => {
        console.log(`Example app listening on port ${port}`);
      });
    })
    .catch((err) => {
      console.error("Failed to connect to database:", err);
      process.exit(1);
    });
}

module.exports = app;