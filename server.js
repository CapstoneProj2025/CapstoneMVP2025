require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const mysql = require("mysql2/promise");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const fs = require("fs/promises");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
});

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "education_platform",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// -------------------- HELPERS --------------------
function makeTempPassword() {
  return crypto
    .randomBytes(8)
    .toString("base64")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 12);
}

async function getParentByEmail(conn, email) {
  const [rows] = await conn.execute(
    "SELECT id, full_name, email, password_hash FROM parents WHERE email = ?",
    [email]
  );
  return rows[0] || null;
}

async function getStudentByEmail(conn, email) {
  const [rows] = await conn.execute(
    "SELECT id, full_name, email, password_hash, age, interest, parent_id, streak_days, last_streak_date FROM students WHERE email = ?",
    [email]
  );
  return rows[0] || null;
}

// NZ date string (YYYY-MM-DD) based on Pacific/Auckland
function nzDateString(date = new Date()) {
  // Using Intl so DST is handled automatically
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Pacific/Auckland",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const y = parts.find(p => p.type === "year")?.value;
  const m = parts.find(p => p.type === "month")?.value;
  const d = parts.find(p => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

// Seconds until next midnight (NZ time)
function secondsUntilNextNZMidnight(now = new Date()) {
  // We compute "tomorrow 00:00" in NZ local terms.
  const nzNow = new Date(
    now.toLocaleString("en-US", { timeZone: "Pacific/Auckland" })
  );

  const next = new Date(nzNow);
  next.setHours(24, 0, 0, 0); // next midnight in NZ-local Date object

  const diffMs = next.getTime() - nzNow.getTime();
  return Math.max(0, Math.floor(diffMs / 1000));
}

app.get("/api/health", (req, res) => res.json({ ok: true }));

// -------------------- AUTH / REGISTER (unchanged logic) --------------------
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

  if (!parentName || !parentEmail || !parentPassword || !studentName || !studentEmail || !studentAge) {
    return res.status(400).json({ success: false, message: "Missing required fields." });
  }

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const existingParent = await getParentByEmail(conn, parentEmail);
    if (existingParent) {
      await conn.rollback();
      conn.release();
      return res.status(409).json({ success: false, message: "Parent email already exists." });
    }

    const existingStudent = await getStudentByEmail(conn, studentEmail);
    if (existingStudent) {
      await conn.rollback();
      conn.release();
      return res.status(409).json({ success: false, message: "Student email already exists." });
    }

    const parentHash = await bcrypt.hash(parentPassword, 10);

    const [parentInsert] = await conn.execute(
      "INSERT INTO parents (full_name, email, password_hash) VALUES (?, ?, ?)",
      [parentName, parentEmail, parentHash]
    );
    const parentId = parentInsert.insertId;

    const tempStudentPassword = makeTempPassword();
    const studentHash = await bcrypt.hash(tempStudentPassword, 10);

    const [studentInsert] = await conn.execute(
      "INSERT INTO students (full_name, email, password_hash, age, interest, parent_id, streak_days, last_streak_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [studentName, studentEmail, studentHash, Number(studentAge), studentInterests, parentId, 0, null]
    );
    const studentId = studentInsert.insertId;

    await conn.commit();
    conn.release();

    return res.json({
      success: true,
      role: "parent",
      parentId,
      studentId,
      studentTempPassword: tempStudentPassword,
      message: "Parent + student created successfully.",
    });
  } catch (err) {
    if (conn) {
      try { await conn.rollback(); } catch {}
      conn.release();
    }
    console.error("❌ Error in /api/register-parent:", err);

    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ success: false, message: "Email already exists." });
    }
    return res.status(500).json({ success: false, message: "Server error during parent registration." });
  }
});

app.post("/api/register-student", async (req, res) => {
  const {
    studentName,
    studentEmail,
    studentPassword,
    studentAge,
    studentInterests,
    parentId,
  } = req.body;

  if (!studentName || !studentEmail || !studentPassword || !studentAge || !studentInterests) {
    return res.status(400).json({ success: false, message: "Missing required fields." });
  }

  let conn;
  try {
    conn = await pool.getConnection();

    const existingStudent = await getStudentByEmail(conn, studentEmail);
    if (existingStudent) {
      conn.release();
      return res.status(409).json({ success: false, message: "Email already exists." });
    }

    const hash = await bcrypt.hash(studentPassword, 10);

    const [sRes] = await conn.execute(
      "INSERT INTO students (full_name, email, password_hash, age, interest, parent_id, streak_days, last_streak_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        studentName,
        studentEmail,
        hash,
        Number(studentAge),
        studentInterests,
        parentId ? Number(parentId) : null,
        0,
        null,
      ]
    );

    conn.release();

    return res.json({
      success: true,
      role: "student",
      studentId: sRes.insertId,
      parentId,
      message: "Student registered successfully.",
    });
  } catch (err) {
    if (conn) conn.release();
    console.error("❌ Error in /api/register-student:", err);

    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ success: false, message: "Email already exists." });
    }
    return res.status(500).json({ success: false, message: "Server error during student registration." });
  }
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, message: "Email and password required." });
  }

  let conn;
  try {
    conn = await pool.getConnection();

    const student = await getStudentByEmail(conn, email);
    if (student) {
      const ok = await bcrypt.compare(password, student.password_hash);
      conn.release();

      if (!ok) return res.status(401).json({ success: false, message: "Invalid password." });

      return res.json({
        success: true,
        role: "student",
        studentId: student.id,
        name: student.full_name,
        interests: student.interest,
        parentId: student.parent_id,
        streakDays: student.streak_days || 0,
        lastStreakDate: student.last_streak_date,
      });
    }

    const parent = await getParentByEmail(conn, email);
    if (parent) {
      const ok = await bcrypt.compare(password, parent.password_hash || "");
      conn.release();

      if (!ok) return res.status(401).json({ success: false, message: "Invalid password." });

      return res.json({
        success: true,
        role: "parent",
        parentId: parent.id,
        name: parent.full_name,
        email: parent.email,
      });
    }

    conn.release();
    return res.status(404).json({ success: false, message: "No account found for that email." });
  } catch (err) {
    if (conn) conn.release();
    console.error("❌ Error in /api/login:", err);
    return res.status(500).json({ success: false, message: "Server error during login." });
  }
});

app.get("/api/parent-dashboard-data", async (req, res) => {
  const parentId = Number(req.query.parentId);
  if (!parentId) {
    return res.status(400).json({ success: false, message: "parentId is required." });
  }

  let conn;
  try {
    conn = await pool.getConnection();

    const [pRows] = await conn.execute(
      "SELECT id, full_name, email FROM parents WHERE id = ?",
      [parentId]
    );
    const parent = pRows[0];
    if (!parent) {
      conn.release();
      return res.status(404).json({ success: false, message: "Parent not found." });
    }

    const [sRows] = await conn.execute(
      "SELECT id, full_name, email, age, interest, streak_days, last_streak_date FROM students WHERE parent_id = ? ORDER BY id ASC",
      [parentId]
    );

    conn.release();

    return res.json({
      success: true,
      parent,
      students: sRows,
    });
  } catch (err) {
    if (conn) conn.release();
    console.error("❌ Error in /api/parent-dashboard-data:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

app.get("/api/content", async (req, res) => {
  try {
    const subject = String(req.query.subject || "").trim();
    const format = String(req.query.format || "").trim();
    const index = Number(req.query.index ?? 0);

    const allowedSubjects = ["Engineering", "Physics", "Maths"];
    const allowedFormats = ["lessons", "videos", "games"];

    if (!allowedSubjects.includes(subject)) {
      return res.status(400).json({ success: false, message: "Invalid subject." });
    }
    if (!allowedFormats.includes(format)) {
      return res.status(400).json({ success: false, message: "Invalid format." });
    }

    const fileMap = {
      Engineering: "engineering.json",
      Physics: "physics.json",
      Maths: "maths.json",
    };

    const contentPath = path.join(__dirname, "content", fileMap[subject]);

    const raw = await fs.readFile(contentPath, "utf-8");
    const data = JSON.parse(raw);

    const list = Array.isArray(data[format]) ? data[format] : [];
    if (!list.length) {
      return res.json({ success: true, subject, format, item: null });
    }

    const safeIndex = Number.isFinite(index)
      ? Math.max(0, Math.min(index, list.length - 1))
      : 0;

    return res.json({ success: true, subject, format, item: list[safeIndex] });
  } catch (err) {
    console.error("❌ Error in /api/content:", err);
    return res.status(500).json({ success: false, message: "Server error loading content." });
  }
});

// -------------------- STREAK ENDPOINTS (ONCE PER DAY + COUNTDOWN) --------------------

app.get("/api/streak", async (req, res) => {
  const studentId = Number(req.query.studentId);
  if (!studentId) {
    return res.status(400).json({ success: false, message: "studentId is required." });
  }

  let conn;
  try {
    conn = await pool.getConnection();
    const [rows] = await conn.execute(
      "SELECT id, full_name, streak_days, last_streak_date FROM students WHERE id = ?",
      [studentId]
    );
    conn.release();

    const s = rows[0];
    if (!s) return res.status(404).json({ success: false, message: "Student not found." });

    return res.json({
      success: true,
      studentId: s.id,
      name: s.full_name,
      streakDays: s.streak_days || 0,
      lastStreakDate: s.last_streak_date,
      secondsUntilNextIncrement: secondsUntilNextNZMidnight(new Date()),
      nzToday: nzDateString(new Date()),
    });
  } catch (err) {
    if (conn) conn.release();
    console.error("❌ Error in /api/streak:", err);
    return res.status(500).json({ success: false, message: "Server error loading streak." });
  }
});

/**
 * POST /api/streak/increment
 * Only increments ONCE per NZ calendar day.
 * Body: { studentId: 123, activity: "lesson"|"video"|"game" }
 */
app.post("/api/streak/increment", async (req, res) => {
  const studentId = Number(req.body.studentId);
  const activity = String(req.body.activity || "").trim().toLowerCase();

  if (!studentId) {
    return res.status(400).json({ success: false, message: "studentId is required." });
  }

  const allowed = ["lesson", "video", "game"];
  if (activity && !allowed.includes(activity)) {
    return res.status(400).json({ success: false, message: "Invalid activity." });
  }

  const todayNZ = nzDateString(new Date());

  let conn;
  try {
    conn = await pool.getConnection();

    // Read current state
    const [rows] = await conn.execute(
      "SELECT streak_days, last_streak_date FROM students WHERE id = ?",
      [studentId]
    );

    if (!rows[0]) {
      conn.release();
      return res.status(404).json({ success: false, message: "Student not found." });
    }

    const currentStreak = rows[0].streak_days || 0;
    const lastDate = rows[0].last_streak_date; // may be null

    // If already incremented today (NZ date), do nothing.
    if (lastDate === todayNZ) {
      conn.release();
      return res.json({
        success: true,
        studentId,
        streakDays: currentStreak,
        incremented: false,
        reason: "already_incremented_today",
        secondsUntilNextIncrement: secondsUntilNextNZMidnight(new Date()),
        nzToday: todayNZ,
      });
    }

    // Not incremented today -> increment and set last_streak_date
    await conn.execute(
      "UPDATE students SET streak_days = COALESCE(streak_days, 0) + 1, last_streak_date = ? WHERE id = ?",
      [todayNZ, studentId]
    );

    const [after] = await conn.execute(
      "SELECT streak_days, last_streak_date FROM students WHERE id = ?",
      [studentId]
    );

    conn.release();

    return res.json({
      success: true,
      studentId,
      streakDays: after[0].streak_days || 0,
      lastStreakDate: after[0].last_streak_date,
      incremented: true,
      secondsUntilNextIncrement: secondsUntilNextNZMidnight(new Date()),
      nzToday: todayNZ,
    });
  } catch (err) {
    if (conn) conn.release();
    console.error("❌ Error in /api/streak/increment:", err);
    return res.status(500).json({ success: false, message: "Server error updating streak." });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
