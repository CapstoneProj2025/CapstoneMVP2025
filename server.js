const express = require("express");
const path = require("path");
const cors = require("cors");
const mysql = require("mysql2/promise");
const bcrypt = require("bcrypt");

const app = express();
const PORT = 3000; // static port

// ------------------ MIDDLEWARE ------------------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files (HTML/CSS/JS)
app.use(express.static(path.join(__dirname)));

// ------------------ DATABASE POOL ------------------
const pool = mysql.createPool({
  host: "localhost",
  user: "root",
  password: "9Beachroad1!", // <- change to your password
  database: "education_platform",
  waitForConnections: true,
  connectionLimit: 10,
});

// Test DB connection
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

// ------------------ ROUTES ------------------

// Health check
app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

// ------------------ REGISTER PARENT + STUDENT (parent signup page) ------------------
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

    // 1) Create parent
    const [parentRes] = await conn.execute(
      `INSERT INTO parents (full_name, email, password_hash, created_at)
       VALUES (?, ?, ?, NOW())`,
      [parentName, parentEmail, hashedPassword]
    );
    const parentId = parentRes.insertId;

    // 2) Create student
    const [studentRes] = await conn.execute(
      `INSERT INTO students (full_name, email, password_hash, age, interest, parent_id, created_at)
       VALUES (?, ?, NULL, ?, ?, ?, NOW())`,
      [studentName, studentEmail, studentAge, studentInterests, parentId]
    );
    const studentId = studentRes.insertId;

    // 3) Bridge record
    await conn.execute(
      `INSERT INTO parent_students (parent_id, student_id)
       VALUES (?, ?)`,
      [parentId, studentId]
    );

    await conn.commit();
    conn.release();

    return res.json({
      success: true,
      parentId,
      studentId,
      role: "parent",
      message: "Parent and student registered successfully.",
    });
  } catch (error) {
    if (conn) {
      await conn.rollback();
      conn.release();
    }
    console.error("❌ Error in /api/register-parent:", error);
    return res.status(500).json({
      success: false,
      message: "Server error during parent registration.",
    });
  }
});

// ------------------ REGISTER STUDENT ONLY (with parent link) ------------------
app.post("/api/register-student", async (req, res) => {
  const {
    studentName,
    studentEmail,
    studentPassword,
    studentAge,
    studentInterests,
    parentName,
    parentEmail,
  } = req.body;

  if (
    !studentName ||
    !studentEmail ||
    !studentPassword ||
    !studentAge ||
    !studentInterests ||
    !parentName ||
    !parentEmail
  ) {
    return res.status(400).json({
      success: false,
      message: "Missing required student or parent fields.",
    });
  }

  let conn;
  try {
    const hashedPassword = await bcrypt.hash(studentPassword, 10);

    conn = await pool.getConnection();
    await conn.beginTransaction();

    // 1) Find or create parent by email
    let parentId;
    const [existingParents] = await conn.execute(
      "SELECT id FROM parents WHERE email = ?",
      [parentEmail]
    );

    if (existingParents.length > 0) {
      parentId = existingParents[0].id;
      // Optionally keep parent name updated
      await conn.execute(
        "UPDATE parents SET full_name = COALESCE(full_name, ?) WHERE id = ?",
        [parentName, parentId]
      );
    } else {
      const [parentRes] = await conn.execute(
        `INSERT INTO parents (full_name, email, password_hash, created_at)
         VALUES (?, ?, NULL, NOW())`,
        [parentName, parentEmail]
      );
      parentId = parentRes.insertId;
    }

    // 2) Insert student
    const [studentRes] = await conn.execute(
      `INSERT INTO students (full_name, email, password_hash, age, interest, parent_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [
        studentName,
        studentEmail,
        hashedPassword,
        studentAge,
        studentInterests,
        parentId,
      ]
    );
    const studentId = studentRes.insertId;

    // 3) Bridge table
    await conn.execute(
      `INSERT INTO parent_students (parent_id, student_id)
       VALUES (?, ?)`,
      [parentId, studentId]
    );

    await conn.commit();
    conn.release();

    return res.json({
      success: true,
      studentId,
      parentId,
      role: "student",
      studentInterests,
      message: "Student registered successfully.",
    });
  } catch (error) {
    if (conn) {
      await conn.rollback();
      conn.release();
    }
    console.error("❌ Error in /api/register-student:", error);

    return res.status(500).json({
      success: false,
      message: "Server error during student registration.",
    });
  }
});

// ------------------ UPDATE STUDENT PROFILE (user-settings page) ------------------
app.post("/api/update-student-profile", async (req, res) => {
  const {
    studentId,
    studentName,
    studentEmail,
    studentAge,
    studentInterests,
    parentName,
    parentEmail,
  } = req.body;

  if (
    !studentId ||
    !studentName ||
    !studentEmail ||
    !studentAge ||
    !studentInterests ||
    !parentName ||
    !parentEmail
  ) {
    return res.status(400).json({
      success: false,
      message: "Missing required fields for profile update.",
    });
  }

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    // 1) Find or create parent
    let parentId;
    const [existingParents] = await conn.execute(
      "SELECT id FROM parents WHERE email = ?",
      [parentEmail]
    );

    if (existingParents.length > 0) {
      parentId = existingParents[0].id;
      await conn.execute(
        "UPDATE parents SET full_name = ? WHERE id = ?",
        [parentName, parentId]
      );
    } else {
      const [parentRes] = await conn.execute(
        `INSERT INTO parents (full_name, email, password_hash, created_at)
         VALUES (?, ?, NULL, NOW())`,
        [parentName, parentEmail]
      );
      parentId = parentRes.insertId;
    }

    // 2) Update student
    await conn.execute(
      `UPDATE students
       SET full_name = ?, email = ?, age = ?, interest = ?, parent_id = ?
       WHERE id = ?`,
      [
        studentName,
        studentEmail,
        studentAge,
        studentInterests,
        parentId,
        studentId,
      ]
    );

    // 3) Bridge link (no dedupe yet)
    await conn.execute(
      `INSERT INTO parent_students (parent_id, student_id)
       VALUES (?, ?)`,
      [parentId, studentId]
    );

    await conn.commit();
    conn.release();

    return res.json({ success: true, message: "Profile updated." });
  } catch (error) {
    if (conn) {
      await conn.rollback();
      conn.release();
    }
    console.error("❌ Error in /api/update-student-profile:", error);

    return res.status(500).json({
      success: false,
      message: "Server error updating profile.",
    });
  }
});

// ------------------ DEFAULT ROUTE ------------------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ------------------ START SERVER ------------------
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
