const express = require("express");
const path = require("path");
const cors = require("cors");
const mysql = require("mysql2/promise");
const bcrypt = require("bcrypt");

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname)));


const pool = mysql.createPool({
  host: "localhost",
  user: "root",
  password: "9Beachroad1!",  
  database: "education_platform",
  waitForConnections: true,
  connectionLimit: 10,
});

(async () => {
  try {
    const conn = await pool.getConnection();
    await conn.ping();
    console.log("✅ Connected to MySQL");
    conn.release();
  } catch (error) {
    console.error("❌ MySQL connection failed:", error);
  }
})();

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/register-parent", async (req, res) => {
  const {
    parentName,
    parentEmail,
    parentPassword,
    studentName,
    studentEmail,
    studentAge,
    studentInterests,
  } = req.body;

  if (
    !parentName ||
    !parentEmail ||
    !parentPassword ||
    !studentName ||
    !studentEmail ||
    !studentAge ||
    !studentInterests
  ) {
    return res.status(400).json({
      success: false,
      message: "Missing required parent or student fields.",
    });
  }

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const hashedPassword = await bcrypt.hash(parentPassword, 10);

    const [parentRes] = await conn.execute(
      `INSERT INTO parents (full_name, email, password_hash, created_at)
       VALUES (?, ?, ?, NOW())`,
      [parentName, parentEmail, hashedPassword]
    );
    const parentId = parentRes.insertId;

    const [studentRes] = await conn.execute(
      `INSERT INTO students (full_name, email, age, interest, parent_id, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [studentName, studentEmail, studentAge, studentInterests, parentId]
    );
    const studentId = studentRes.insertId;

    await conn.commit();
    conn.release();

    return res.json({
      success: true,
      parentId,
      studentId,
      role: "parent",
      message: "Parent + student registered successfully.",
    });
  } catch (error) {
    if (conn) await conn.rollback();
    console.error("❌ Error in /api/register-parent:", error);

    return res.status(500).json({
      success: false,
      message: "Server error during registration.",
    });
  }
});

app.post("/api/register-student", async (req, res) => {
  const {
    studentName,
    studentEmail,
    studentPassword,
    studentAge,
    studentInterests,
  } = req.body;

  if (
    !studentName ||
    !studentEmail ||
    !studentPassword ||
    !studentAge ||
    !studentInterests
  ) {
    return res.status(400).json({
      success: false,
      message: "Missing required student fields.",
    });
  }

  try {
    const hashedPassword = await bcrypt.hash(studentPassword, 10);

    const [result] = await pool.execute(
      `INSERT INTO students (full_name, email, password_hash, age, interest, parent_id, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, NOW())`,
      [studentName, studentEmail, hashedPassword, studentAge, studentInterests]
    );

    return res.json({
      success: true,
      studentId: result.insertId,
      role: "student",
      message: "Student registered successfully.",
    });
  } catch (error) {
    console.error("❌ Error in /api/register-student:", error);

    return res.status(500).json({
      success: false,
      message: "Server error during student registration.",
    });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
