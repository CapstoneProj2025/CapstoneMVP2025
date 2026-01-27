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
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Pacific/Auckland",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

// Seconds until next midnight (NZ time)
function secondsUntilNextNZMidnight(now = new Date()) {
  const nzNow = new Date(
    now.toLocaleString("en-US", { timeZone: "Pacific/Auckland" })
  );

  const next = new Date(nzNow);
  next.setHours(24, 0, 0, 0);

  const diffMs = next.getTime() - nzNow.getTime();
  return Math.max(0, Math.floor(diffMs / 1000));
}

app.get("/api/health", (req, res) => res.json({ ok: true }));

// -------------------- AUTH / REGISTER --------------------
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
    !studentAge
  ) {
    return res
      .status(400)
      .json({ success: false, message: "Missing required fields." });
  }

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const existingParent = await getParentByEmail(conn, parentEmail);
    if (existingParent) {
      await conn.rollback();
      conn.release();
      return res
        .status(409)
        .json({ success: false, message: "Parent email already exists." });
    }

    const existingStudent = await getStudentByEmail(conn, studentEmail);
    if (existingStudent) {
      await conn.rollback();
      conn.release();
      return res
        .status(409)
        .json({ success: false, message: "Student email already exists." });
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
      [
        studentName,
        studentEmail,
        studentHash,
        Number(studentAge),
        studentInterests,
        parentId,
        0,
        null,
      ]
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
      try {
        await conn.rollback();
      } catch {}
      conn.release();
    }
    console.error("❌ Error in /api/register-parent:", err);

    if (err.code === "ER_DUP_ENTRY") {
      return res
        .status(409)
        .json({ success: false, message: "Email already exists." });
    }
    return res.status(500).json({
      success: false,
      message: "Server error during parent registration.",
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
    parentName,
    parentEmail,
  } = req.body;

  if (
    !studentName ||
    !studentEmail ||
    !studentPassword ||
    !studentAge ||
    !studentInterests
  ) {
    return res
      .status(400)
      .json({ success: false, message: "Missing required fields." });
  }

  let conn;
  try {
    conn = await pool.getConnection();

    const existingStudent = await getStudentByEmail(conn, studentEmail);
    if (existingStudent) {
      conn.release();
      return res
        .status(409)
        .json({ success: false, message: "Email already exists." });
    }

    const hash = await bcrypt.hash(studentPassword, 10);

    // Try to find parent by email if provided
    let parentId = null;
    if (parentEmail) {
      const parent = await getParentByEmail(conn, parentEmail);
      if (parent) {
        parentId = parent.id;
      }
    }

    const [sRes] = await conn.execute(
      "INSERT INTO students (full_name, email, password_hash, age, interest, parent_id, streak_days, last_streak_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        studentName,
        studentEmail,
        hash,
        Number(studentAge),
        studentInterests,
        parentId,
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
      return res
        .status(409)
        .json({ success: false, message: "Email already exists." });
    }
    return res.status(500).json({
      success: false,
      message: "Server error during student registration.",
    });
  }
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res
      .status(400)
      .json({ success: false, message: "Email and password required." });
  }

  let conn;
  try {
    conn = await pool.getConnection();

    const student = await getStudentByEmail(conn, email);
    if (student) {
      const ok = await bcrypt.compare(password, student.password_hash);
      conn.release();

      if (!ok)
        return res
          .status(401)
          .json({ success: false, message: "Invalid password." });

      return res.json({
        success: true,
        role: "student",
        studentId: student.id,
        name: student.full_name,
        email: student.email,
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

      if (!ok)
        return res
          .status(401)
          .json({ success: false, message: "Invalid password." });

      return res.json({
        success: true,
        role: "parent",
        parentId: parent.id,
        name: parent.full_name,
        email: parent.email,
      });
    }

    conn.release();
    return res
      .status(404)
      .json({ success: false, message: "No account found for that email." });
  } catch (err) {
    if (conn) conn.release();
    console.error("❌ Error in /api/login:", err);
    return res
      .status(500)
      .json({ success: false, message: "Server error during login." });
  }
});

// ✅ NEW ENDPOINT: Get student dashboard data by studentId
app.get("/api/student-dashboard-data", async (req, res) => {
  const studentId = Number(req.query.studentId);
  console.log("📍 Received request for studentId:", req.query.studentId, "→ Parsed as:", studentId);
  
  if (!studentId) {
    console.log("❌ Invalid studentId");
    return res
      .status(400)
      .json({ success: false, message: "studentId is required." });
  }

  let conn;
  try {
    conn = await pool.getConnection();

    const [sRows] = await conn.execute(
      "SELECT id, full_name, email, age, interest, parent_id, streak_days, last_streak_date FROM students WHERE id = ?",
      [studentId]
    );
    
    console.log("📦 Query result:", sRows);
    
    const student = sRows[0];
    if (!student) {
      conn.release();
      console.log("❌ Student not found for ID:", studentId);
      return res
        .status(404)
        .json({ success: false, message: "Student not found." });
    }

    console.log("✅ Found student:", student.full_name);

    // Get parent info if parent_id exists
    let parent = null;
    if (student.parent_id) {
      const [pRows] = await conn.execute(
        "SELECT id, full_name, email FROM parents WHERE id = ?",
        [student.parent_id]
      );
      parent = pRows[0] || null;
      console.log("✅ Found parent:", parent ? parent.full_name : "None");
    }

    conn.release();

    const responseData = {
      success: true,
      student: {
        id: student.id,
        name: student.full_name,
        email: student.email,
        age: student.age,
        interests: student.interest,
        streakDays: student.streak_days || 0,
        lastStreakDate: student.last_streak_date,
      },
      parent: parent ? {
        id: parent.id,
        name: parent.full_name,
        email: parent.email,
      } : null,
    };
    
    console.log("✅ Sending response:", responseData);
    return res.json(responseData);
  } catch (err) {
    if (conn) conn.release();
    console.error("❌ Error in /api/student-dashboard-data:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

app.get("/api/parent-dashboard-data", async (req, res) => {
  const parentId = Number(req.query.parentId);
  if (!parentId) {
    return res
      .status(400)
      .json({ success: false, message: "parentId is required." });
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
      return res
        .status(404)
        .json({ success: false, message: "Parent not found." });
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
    return res
      .status(500)
      .json({ success: false, message: "Server error loading content." });
  }
});

// -------------------- STREAK ENDPOINTS (ONCE PER DAY + RESET IF MISSED DAY + COUNTDOWN) --------------------

app.get("/api/streak", async (req, res) => {
  const studentId = Number(req.query.studentId);
  if (!studentId) {
    return res
      .status(400)
      .json({ success: false, message: "studentId is required." });
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
    return res
      .status(500)
      .json({ success: false, message: "Server error loading streak." });
  }
});

/**
 * POST /api/streak/increment
 * - Only increments ONCE per NZ calendar day
 * - If user misses a full day (i.e. last_streak_date is older than yesterday), streak resets to 1
 * Body: { studentId: 123, activity: "lesson"|"video"|"game" }
 */
app.post("/api/streak/increment", async (req, res) => {
  const studentId = Number(req.body.studentId);
  const activity = String(req.body.activity || "").trim().toLowerCase();

  if (!studentId) {
    return res
      .status(400)
      .json({ success: false, message: "studentId is required." });
  }

  const allowed = ["lesson", "video", "game"];
  if (activity && !allowed.includes(activity)) {
    return res.status(400).json({ success: false, message: "Invalid activity." });
  }

  // NZ today & yesterday strings
  const now = new Date();
  const nzNow = new Date(now.toLocaleString("en-US", { timeZone: "Pacific/Auckland" }));
  const todayNZ = nzDateString(nzNow);

  const y = new Date(nzNow);
  y.setDate(y.getDate() - 1);
  const yesterdayNZ = nzDateString(y);

  let conn;
  try {
    conn = await pool.getConnection();

    // Read current state (for incremented flag)
    const [beforeRows] = await conn.execute(
      "SELECT streak_days, last_streak_date FROM students WHERE id = ?",
      [studentId]
    );

    if (!beforeRows[0]) {
      conn.release();
      return res.status(404).json({ success: false, message: "Student not found." });
    }

    // Atomic update inside MySQL:
    // - last_streak_date == todayNZ -> do nothing
    // - last_streak_date == yesterdayNZ -> streak_days + 1
    // - else (null/older) -> reset streak_days to 1
    await conn.execute(
      `
      UPDATE students
      SET
        streak_days = CASE
          WHEN last_streak_date = ? THEN COALESCE(streak_days, 0)
          WHEN last_streak_date = ? THEN COALESCE(streak_days, 0) + 1
          ELSE 1
        END,
        last_streak_date = CASE
          WHEN last_streak_date = ? THEN last_streak_date
          ELSE ?
        END
      WHERE id = ?
      `,
      [todayNZ, yesterdayNZ, todayNZ, todayNZ, studentId]
    );

    // Fetch after
    const [afterRows] = await conn.execute(
      "SELECT streak_days, last_streak_date FROM students WHERE id = ?",
      [studentId]
    );

    conn.release();

    const beforeLast = beforeRows[0].last_streak_date;
    const afterLast = afterRows[0].last_streak_date;

    // If the last date changed to today, we incremented (either +1 or reset->1)
    const incremented = (afterLast === todayNZ) && (beforeLast !== todayNZ);

    return res.json({
      success: true,
      studentId,
      streakDays: afterRows[0].streak_days || 0,
      lastStreakDate: afterRows[0].last_streak_date,
      incremented,
      secondsUntilNextIncrement: secondsUntilNextNZMidnight(new Date()),
      nzToday: todayNZ,
    });
  } catch (err) {
    if (conn) conn.release();
    console.error("❌ Error in /api/streak/increment:", err);
    return res
      .status(500)
      .json({ success: false, message: "Server error updating streak." });
  }
});

// -------------------- ACTIVITY TRACKING ENDPOINTS --------------------

/**
 * POST /api/activity/log
 * Log a student activity (lesson, video, or game)
 * Body: { studentId, activityType, subject, contentTitle, durationMinutes }
 */
app.post("/api/activity/log", async (req, res) => {
  const { studentId, activityType, subject, contentTitle, durationMinutes } = req.body;

  if (!studentId || !activityType || !subject) {
    return res
      .status(400)
      .json({ success: false, message: "studentId, activityType, and subject are required." });
  }

  const allowed = ["lesson", "video", "game"];
  if (!allowed.includes(activityType)) {
    return res.status(400).json({ success: false, message: "Invalid activityType." });
  }

  let conn;
  try {
    conn = await pool.getConnection();

    // Insert activity log
    await conn.execute(
      `INSERT INTO student_activities 
       (student_id, activity_type, subject, content_title, duration_minutes, completed) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [studentId, activityType, subject, contentTitle || null, durationMinutes || 5, true]
    );

    // Update or create daily session
    const today = new Date().toISOString().split('T')[0];
    
    await conn.execute(
      `INSERT INTO daily_sessions 
       (student_id, session_date, total_minutes, lessons_count, videos_count, games_count)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         total_minutes = total_minutes + VALUES(total_minutes),
         lessons_count = lessons_count + VALUES(lessons_count),
         videos_count = videos_count + VALUES(videos_count),
         games_count = games_count + VALUES(games_count),
         updated_at = CURRENT_TIMESTAMP`,
      [
        studentId,
        today,
        durationMinutes || 5,
        activityType === 'lesson' ? 1 : 0,
        activityType === 'video' ? 1 : 0,
        activityType === 'game' ? 1 : 0
      ]
    );

    conn.release();

    return res.json({
      success: true,
      message: "Activity logged successfully"
    });
  } catch (err) {
    if (conn) conn.release();
    console.error("❌ Error in /api/activity/log:", err);
    return res
      .status(500)
      .json({ success: false, message: "Server error logging activity." });
  }
});

/**
 * GET /api/activity/analytics
 * Get analytics data for a student
 * Query params: studentId, days (optional, default 7)
 */
app.get("/api/activity/analytics", async (req, res) => {
  const studentId = Number(req.query.studentId);
  const days = Number(req.query.days) || 7;

  if (!studentId) {
    return res
      .status(400)
      .json({ success: false, message: "studentId is required." });
  }

  let conn;
  try {
    conn = await pool.getConnection();

    // Get daily sessions for the past N days
    const [sessions] = await conn.execute(
      `SELECT session_date, total_minutes, lessons_count, videos_count, games_count
       FROM daily_sessions
       WHERE student_id = ? AND session_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       ORDER BY session_date ASC`,
      [studentId, days]
    );

    // Get subject distribution
    const [subjectDist] = await conn.execute(
      `SELECT subject, COUNT(*) as count
       FROM student_activities
       WHERE student_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
       GROUP BY subject`,
      [studentId]
    );

    // Get recent activities
    const [recentActivities] = await conn.execute(
      `SELECT activity_type, subject, content_title, created_at
       FROM student_activities
       WHERE student_id = ?
       ORDER BY created_at DESC
       LIMIT 10`,
      [studentId]
    );

    // Get total stats
    const [totalStats] = await conn.execute(
      `SELECT 
         COUNT(*) as total_activities,
         SUM(CASE WHEN activity_type = 'lesson' THEN 1 ELSE 0 END) as total_lessons,
         SUM(duration_minutes) as total_minutes
       FROM student_activities
       WHERE student_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`,
      [studentId]
    );

    conn.release();

    return res.json({
      success: true,
      data: {
        dailySessions: sessions,
        subjectDistribution: subjectDist,
        recentActivities: recentActivities,
        totalStats: totalStats[0] || { total_activities: 0, total_lessons: 0, total_minutes: 0 }
      }
    });
  } catch (err) {
    if (conn) conn.release();
    console.error("❌ Error in /api/activity/analytics:", err);
    return res
      .status(500)
      .json({ success: false, message: "Server error fetching analytics." });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});