const express = require('express');
const { Pool } = require('pg'); // تم التغيير من sqlite3 إلى pg
const path = require('path');
const cookieParser = require('cookie-parser');

/**
 * إعدادات التطبيق الأساسية
 */
const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = "dalimo"; 

// إعداد الاتصال بـ Supabase
const pool = new Pool({
    connectionString: "postgresql://postgres.nbtfrxifzctbkswfwoyx:Barhoum307*@aws-1-ap-northeast-2.pooler.supabase.com:6543/postgres?pgbouncer=true",
    ssl: { rejectUnauthorized: false }
});

// الإعدادات (Middleware)
app.use(cookieParser());
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json()); 
app.use(express.static(path.join(__dirname, 'public')));

/**
 * نظام تهيئة قاعدة البيانات (PostgreSQL)
 */
async function initializeDatabase() {
    try {
        const client = await pool.connect();
        console.log("✅ تم الاتصال بنجاح بـ Supabase");

        // إنشاء الجداول بنظام PostgreSQL (استخدام SERIAL بدلاً من AUTOINCREMENT)
        await client.query(`
            CREATE TABLE IF NOT EXISTS announcements (id SERIAL PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, date TEXT NOT NULL, priority TEXT DEFAULT 'normal');
            CREATE TABLE IF NOT EXISTS enseignants (id SERIAL PRIMARY KEY, nom TEXT NOT NULL, matiere TEXT, phone_number TEXT, password TEXT DEFAULT '0000', rank TEXT DEFAULT 'معلم', is_admin_duty INTEGER DEFAULT 0, weekly_load INTEGER DEFAULT 0, last_login TEXT);
            CREATE TABLE IF NOT EXISTS school_classes (id SERIAL PRIMARY KEY, class_name TEXT UNIQUE, num_sections INTEGER);
            CREATE TABLE IF NOT EXISTS affectations (id SERIAL PRIMARY KEY, enseignant_id INTEGER REFERENCES enseignants(id) ON DELETE CASCADE, classe TEXT, section TEXT);
            CREATE TABLE IF NOT EXISTS timetable (id SERIAL PRIMARY KEY, enseignant_id INTEGER REFERENCES enseignants(id) ON DELETE CASCADE, classe TEXT, section TEXT, jour TEXT, periode INTEGER, matiere TEXT);
            CREATE TABLE IF NOT EXISTS absences (id SERIAL PRIMARY KEY, enseignant_id INTEGER REFERENCES enseignants(id), date TEXT, raison TEXT, status TEXT DEFAULT 'pending');
            CREATE TABLE IF NOT EXISTS substitute_logs (id SERIAL PRIMARY KEY, substitute_id INTEGER REFERENCES enseignants(id), absent_id INTEGER REFERENCES enseignants(id), date TEXT, periode INTEGER, classe TEXT, section TEXT, status TEXT DEFAULT 'pending', reject_reason TEXT);
            CREATE TABLE IF NOT EXISTS eleves (id SERIAL PRIMARY KEY, nom TEXT NOT NULL, classe TEXT, section TEXT, parent_phone TEXT);
            CREATE TABLE IF NOT EXISTS student_absences (id SERIAL PRIMARY KEY, eleve_id INTEGER REFERENCES eleves(id) ON DELETE CASCADE, enseignant_id INTEGER REFERENCES enseignants(id), date TEXT, periode INTEGER, justified INTEGER DEFAULT 0);
            CREATE TABLE IF NOT EXISTS behavior_logs (id SERIAL PRIMARY KEY, student_id INTEGER REFERENCES eleves(id) ON DELETE CASCADE, teacher_id INTEGER REFERENCES enseignants(id) ON DELETE CASCADE, event TEXT, date TEXT, severity TEXT DEFAULT 'low');
            CREATE TABLE IF NOT EXISTS school_subjects (id SERIAL PRIMARY KEY, name TEXT UNIQUE);
            CREATE TABLE IF NOT EXISTS school_periods (id SERIAL PRIMARY KEY, start_time TEXT, end_time TEXT);
            CREATE TABLE IF NOT EXISTS evaluation_requests (id SERIAL PRIMARY KEY, eleve_id INTEGER NOT NULL REFERENCES eleves(id) ON DELETE CASCADE, enseignant_id INTEGER NOT NULL REFERENCES enseignants(id) ON DELETE CASCADE, date_request TEXT NOT NULL, status TEXT DEFAULT 'pending');
            CREATE TABLE IF NOT EXISTS academic_evaluations (id SERIAL PRIMARY KEY, eleve_id INTEGER NOT NULL REFERENCES eleves(id) ON DELETE CASCADE, enseignant_id INTEGER NOT NULL REFERENCES enseignants(id) ON DELETE CASCADE, level TEXT NOT NULL, remark TEXT, date_submission TEXT NOT NULL);
        `);

        client.release();
        console.log("✅ قاعدة البيانات جاهزة ومحدثة بالكامل.");
    } catch (err) {
        console.error("❌ فشل في تهيئة قاعدة البيانات:", err);
        process.exit(1);
    }
}

/**
 * Middleware حماية المسارات الإدارية
 */
function isAdmin(req, res, next) {
    if (req.path === '/login') return next();
    if (req.cookies.admin_auth === 'authenticated') return next();
    res.redirect('/admin/login');
}

/**
 * تشغيل الخادم
 */
initializeDatabase().then(() => {



// مسار حذف إسناد فصل محدد عن معلم
app.get('/admin/enseignants/supprimer-affectation/:id', async (req, res) => {
    const { id } = req.params;
    try {
        // حذف السجل من جدول الإسنادات (affectations)
        await pool.query("DELETE FROM affectations WHERE id = $1", [id]);
        
        // نرسل رد نجاح (200) لأن الواجهة تستخدم fetch وتنتظر استجابة
        res.sendStatus(200); 
    } catch (e) {
        console.error("Error deleting assignment:", e);
        res.status(500).send("خطأ في حذف الإسناد");
    }
});




// --- [ نظام التقييم الأكاديمي ] ---

app.get('/teacher/evaluate/:requestId/:studentId', async (req, res) => {
    try {
        const { requestId, studentId } = req.params;
        const requestData = (await pool.query("SELECT enseignant_id FROM evaluation_requests WHERE id = $1", [requestId])).rows[0];
        
        if (!requestData) return res.status(404).send("طلب التقييم هذا غير موجود");

        const teacher_id = requestData.enseignant_id;
        const student = (await pool.query("SELECT * FROM students WHERE id = $1", [parseInt(studentId)])).rows[0];
        
        if (!student) return res.status(404).send("الطالب غير موجود");

        res.render('teacher_evaluation', { student, requestId, teacher_id, titre: "تقييم المستوى الأكاديمي" });
    } catch (e) {
        console.error(e);
        res.status(500).send("خطأ في تحميل الصفحة");
    }
});

app.post('/teacher/evaluate/submit', async (req, res) => {
    try {
        const { student_id, level, remark, request_id, teacher_id } = req.body;
        const date_now = new Date().toISOString().split('T')[0];

        // 1. إدخال التقييم
        await pool.query(`INSERT INTO academic_evaluations (eleve_id, enseignant_id, level, remark, date_submission) VALUES ($1, $2, $3, $4, $5)`, 
            [student_id, teacher_id, level, remark, date_now]);

        // 2. تحديث حالة الطلب إلى مكتمل
        await pool.query("UPDATE evaluation_requests SET status = 'completed' WHERE id = $1", [request_id]);

        // 3. إضافة النجمة (الجزء الجديد)
        // نستخدم COALESCE لضمان أنه إذا كانت القيمة NULL تبدأ من 0
        await pool.query("UPDATE enseignants SET stars_count = COALESCE(stars_count, 0) + 1 WHERE id = $1", [teacher_id]);

        // 4. إعادة التوجيه
        res.redirect(`/teacher/dashboard/${teacher_id}?success=evaluated`);
    } catch (e) {
        console.error("Error in evaluation submission:", e);
        res.status(500).send("خطأ أثناء حفظ التقييم");
    }
});

app.post('/admin/students/request-evaluation', async (req, res) => {
    try {
        const { student_id } = req.body;
        if (!student_id) return res.status(400).send("لم يتم اختيار طالب");

        const student = (await pool.query("SELECT * FROM students WHERE id = $1", [parseInt(student_id)])).rows[0];
        if (!student) return res.status(404).send("عذراً، الطالب غير موجود");

        const teachers = (await pool.query("SELECT enseignant_id FROM affectations WHERE classe = $1 AND section = $2", [student.classe, student.section])).rows;
        const date_request = new Date().toISOString().split('T')[0];

        for (const t of teachers) {
            await pool.query("INSERT INTO evaluation_requests (eleve_id, enseignant_id, date_request, status) VALUES ($1, $2, $3, 'pending')", 
                [student.id, t.enseignant_id, date_request]);
        }
        res.redirect('/admin/student-reports-list?success=1');
    } catch (e) {
        console.error(e);
        res.status(500).send("حدث خطأ أثناء معالجة طلبك");
    }
});

    // --- [ 1. بوابات الدخول ] ---

    app.get('/', (req, res) => res.redirect('/teacher/login'));

    app.get('/admin/login', (req, res) => res.render('admin_login', { error: null, titre: "دخول الإدارة" }));

    app.post('/admin/login', (req, res) => {
        const { password } = req.body;
        if (password === ADMIN_PASSWORD) {
            res.cookie('admin_auth', 'authenticated', { httpOnly: true });
            return res.redirect('/admin/dashboard');
        } else {
            return res.render('admin_login', { error: "خطأ", titre: "دخول" });
        }
    });

    app.use('/admin', isAdmin);

    // --- [ 3. لوحة تحكم المدير ] ---

   app.get('/admin/dashboard', async (req, res) => {
    try {
        // الاستعلامات المعتمدة على الهيكلية التي أرسلتها
        const queries = {
            // 1. إجمالي المعلمين والطلاب
            teachersCount: "SELECT COUNT(*) as c FROM enseignants",
            studentsCount: "SELECT COUNT(*) as c FROM students",
            
            // 2. غياب المعلمين اليوم (جدول daily_absences)
            profAbsences: "SELECT COUNT(*) as c FROM daily_absences WHERE date = CURRENT_DATE",
            
            // 3. غياب الطلاب اليوم (جدول student_absences)
            studentAbsences: "SELECT COUNT(*) as c FROM student_absences WHERE date = CURRENT_DATE::text",
            
            // 4. المعلمون المتصلون (بناءً على آخر ظهور في آخر 5 دقائق مثلاً)
            // ملاحظة: بما أنه لا يوجد حقل is_online، سنستخدم last_login
            onlineTeachers: "SELECT COUNT(*) as c FROM enseignants WHERE last_login >= (NOW() - INTERVAL '5 minutes')::text",
            
            // 5. تقارير السلوك (behavior_logs) - لنفترض أنSeverity هي وسيلة الفلترة أو جلب آخر التقارير
            recentBehaviors: "SELECT COUNT(*) as c FROM behavior_logs WHERE date = CURRENT_DATE::text"
        };

        const [t, s, pa, sa, ot, rb] = await Promise.all([
            pool.query(queries.teachersCount),
            pool.query(queries.studentsCount),
            pool.query(queries.profAbsences),
            pool.query(queries.studentAbsences),
            pool.query(queries.onlineTeachers),
            pool.query(queries.recentBehaviors)
        ]);

        res.render('admin_dashboard', { 
            ecole: "مدرسة ابن دريد", 
            titre: "لوحة التحكم", 
            stats: { 
                teachers: t.rows[0].c, 
                students: s.rows[0].c, 
                absences: pa.rows[0].c,        // غياب المعلمين اليوم
                studentAbsences: sa.rows[0].c, // غياب الطلاب اليوم
                online: ot.rows[0].c,          // المعلمون النشطون
                unreadBehaviors: rb.rows[0].c  // بلاغات السلوك اليوم
            } 
        });
    } catch (e) {
        console.error("❌ Error fetching dashboard stats:", e);
        res.status(500).send("خطأ في جلب إحصائيات اللوحة من Supabase");
    }
});

    // --- [ 4. إدارة المعلمين والتعيينات ] ---

    app.get('/admin/enseignants', async (req, res) => {
        try {
            const enseignants = (await pool.query("SELECT * FROM enseignants ORDER BY nom ASC")).rows;
            const affectations = (await pool.query("SELECT a.*, e.nom FROM affectations a JOIN enseignants e ON a.enseignant_id = e.id")).rows;
            const subjects = (await pool.query("SELECT * FROM school_subjects")).rows;
            const classes = (await pool.query("SELECT * FROM school_classes")).rows;
            res.render('gestion_enseignants', { 
                enseignants, affectations, subjects, classes, titre: "إدارة المعلمين" 
            });
        } catch (e) {
            res.status(500).send("خطأ في تحميل بيانات المعلمين");
        }
    });

    app.post('/admin/enseignants/ajouter', async (req, res) => {
        const { nom, matiere, phone } = req.body;
        try {
            await pool.query("INSERT INTO enseignants (nom, matiere, phone_number) VALUES ($1, $2, $3)", [nom, matiere, phone]);
            res.redirect('/admin/enseignants');
        } catch (e) {
            res.status(500).send("خطأ أثناء إضافة معلم جديد");
        }
    });
    //11111111/////
   // --- [ تابع: إدارة المعلمين والتعيينات ] ---

    // مسار تحديث بيانات المعلم
    app.post('/admin/enseignants/modifier', async (req, res) => {
        try {
            const { id, nom, matiere, phone_number } = req.body;
            await pool.query(
                "UPDATE enseignants SET nom = $1, matiere = $2, phone_number = $3 WHERE id = $4", 
                [nom, matiere, phone_number, id]
            );
            res.redirect('/admin/enseignants?success=updated');
        } catch (e) {
            console.error("Update Error:", e);
            res.status(500).send("خطأ في تحديث البيانات");
        }
    });

   app.post('/admin/enseignants/affecter-multiple', async (req, res) => {
    const { enseignant_id, classes_data } = req.body;
    
    try {
        // 1. جلب بيانات المعلم
        const teacherResult = await pool.query("SELECT nom, matiere FROM enseignants WHERE id = $1", [enseignant_id]);
        const currentTeacher = teacherResult.rows[0];
        
        if (!currentTeacher) {
            return res.status(404).json({ message: "المعلم غير موجود" });
        }

        // 2. فحص التعارضات لجميع الفصول في المصفوفة قبل البدء
        for (const item of classes_data) {
            const [classe, section] = item.split('|');
            
            const conflictResult = await pool.query(`
                SELECT e.nom FROM affectations a 
                JOIN enseignants e ON a.enseignant_id = e.id 
                WHERE a.classe = $1 AND a.section = $2 AND e.matiere = $3
            `, [classe, section, currentTeacher.matiere]);

            if (conflictResult.rows.length > 0) {
                const conflict = conflictResult.rows[0];
                return res.status(400).json({ 
                    message: `تعارض: الفصل ${classe} (${section}) لديه مدرس ${currentTeacher.matiere} بالفعل وهو: ${conflict.nom}` 
                });
            }
        }

        // 3. إذا لم يوجد تعارض، نقوم بالإسناد الفعلي
        for (const item of classes_data) {
            const [classe, section] = item.split('|');
            
            // تجنب التكرار لنفس المعلم
            const exists = await pool.query(
                "SELECT id FROM affectations WHERE enseignant_id = $1 AND classe = $2 AND section = $3", 
                [enseignant_id, classe, section]
            );

            if (exists.rows.length === 0) {
                await pool.query(
                    "INSERT INTO affectations (enseignant_id, classe, section) VALUES ($1, $2, $3)", 
                    [enseignant_id, classe, section]
                );
            }
        }

        res.status(200).json({ message: "تم إسناد جميع الفصول المختارة بنجاح" });

    } catch (e) {
        console.error(e);
        res.status(500).json({ message: "خطأ فني في السيرفر" });
    }
});

    // --- [ 5. إدارة الجدول الزمني ] ---

    /*
    
    
    app.get('/admin/timetable', async (req, res) => {
        try {
            const t_filter = req.query.teacher_filter || ""; 
            const c_filter = req.query.class_filter || ""; 
            const enseignants = (await pool.query("SELECT * FROM enseignants ORDER BY nom")).rows;
            const classes = (await pool.query("SELECT * FROM school_classes")).rows;
            const all_affectations = (await pool.query("SELECT * FROM affectations")).rows; 
            const unique_classes = (await pool.query("SELECT DISTINCT classe, section FROM timetable ORDER BY classe, section")).rows;
            
            let queryStr = `SELECT t.*, e.nom as prof_nom FROM timetable t JOIN enseignants e ON t.enseignant_id = e.id WHERE 1=1`;
            let params = [];
            
            if (t_filter) { queryStr += ` AND t.enseignant_id = $1`; params.push(t_filter); }
            if (c_filter) {
                const parts = c_filter.split('-');
                if(parts.length === 2) {
                    queryStr += ` AND t.classe = $${params.length+1} AND t.section = $${params.length+2}`;
                    params.push(parts[0], parts[1]);
                }
            }
            const schedule = (await pool.query(queryStr, params)).rows;
            res.render('gestion_timetable', { enseignants, schedule, classes, all_affectations, teacher_filter: t_filter, class_filter: c_filter, unique_classes, titre: "الجدول المدرسي" });
        } catch (e) { res.status(500).send("خطأ في تحميل الجدول"); }
    });
    */ 
/*
 app.post('/admin/timetable/ajouter', async (req, res) => {
        try {
            const { enseignant_id, class_info, jour, periode } = req.body;
            const [classe, section] = class_info.split('|');
            const prof = (await pool.query("SELECT matiere FROM enseignants WHERE id = $1", [enseignant_id])).rows[0];

            const teacherConflict = (await pool.query("SELECT id FROM timetable WHERE enseignant_id = $1 AND jour = $2 AND periode = $3", [enseignant_id, jour, periode])).rows[0];
            if (teacherConflict) return res.redirect('/admin/timetable?error=teacher_busy');

            const classConflict = (await pool.query("SELECT id FROM timetable WHERE classe = $1 AND section = $2 AND jour = $3 AND periode = $4", [classe, section, jour, periode])).rows[0];
            if (classConflict) return res.redirect('/admin/timetable?error=class_busy');

            await pool.query("INSERT INTO timetable (enseignant_id, classe, section, jour, periode, matiere) VALUES ($1, $2, $3, $4, $5, $6)",
                [enseignant_id, classe, section, jour, periode, prof.matiere]);
            res.redirect('/admin/timetable?success=added');
        } catch (e) { res.redirect('/admin/timetable?error=server'); }
    });
*/ 
   

    // --- [ 6. إدارة غياب المعلمين والاحتياط ] ---

   app.get('/admin/absence-profs', async (req, res) => {
    try {
        // 1. ضبط التاريخ المحلي الصحيح (عمان/الخليج/الجزائر حسب منطقتك)
        // 'en-CA' تعطي تنسيق YYYY-MM-DD
        const options = { timeZone: 'Asia/Muscat', year: 'numeric', month: '2-digit', day: '2-digit' };
        // استخدم هذا السطر لضمان التاريخ المحلي الصحيح عند الحفظ
const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Muscat', // أو توقيت بلدك
    year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date());
        // 2. الحصول على اسم اليوم المحلي الصحيح
        const days = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
        const localDate = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Muscat"}));
        const todayName = days[localDate.getDay()];

        // جلب قائمة المعلمين بالكامل
        const enseignants = (await pool.query("SELECT * FROM enseignants ORDER BY nom ASC")).rows;

        // جلب الحصص التي تحتاج بدلاء (لم يتم تعيينها بعد)
        const ghaibeen = (await pool.query(`
            SELECT DISTINCT e.id as teacher_id, e.nom, e.matiere, t.periode, t.classe, t.section
            FROM absences a 
            JOIN enseignants e ON a.enseignant_id = e.id 
            JOIN timetable t ON e.id = t.enseignant_id
            WHERE a.date = $1 
            AND (t.jour = $2 OR t.jour = REPLACE($2, 'إ', 'ا'))
            AND NOT EXISTS (
                SELECT 1 FROM substitute_logs sl 
                WHERE sl.absent_id = e.id 
                AND sl.date = a.date 
                AND sl.periode = t.periode 
                AND sl.status IN ('accepted', 'pending')
            ) 
            ORDER BY t.periode ASC`, [today, todayName])).rows;

        // اقتراح المعلمين البدلاء (الأقل حصص احتياط هذا الشهر والأقل نصاب أسبوعي)
        const suggestions = (await pool.query(`
            SELECT e.*, 
            (SELECT COUNT(*) FROM substitute_logs 
             WHERE substitute_id = e.id 
             AND EXTRACT(MONTH FROM TO_DATE(date, 'YYYY-MM-DD')) = EXTRACT(MONTH FROM CURRENT_DATE)) as reserve_this_month
            FROM enseignants e 
            WHERE e.id NOT IN (SELECT enseignant_id FROM absences WHERE date = $1)
            ORDER BY reserve_this_month ASC, weekly_load ASC`, [today])).rows;

        // ملخص الحصص التي تم تغطيتها اليوم فعلياً
        const recapSubstitutions = (await pool.query(`
            SELECT sl.*, sub.nom as substitute_name, abs_p.nom as absent_name 
            FROM substitute_logs sl 
            LEFT JOIN enseignants sub ON sl.substitute_id = sub.id 
            LEFT JOIN enseignants abs_p ON sl.absent_id = abs_p.id
            WHERE sl.date = $1 
            ORDER BY sl.periode ASC`, [today])).rows;

        res.render('gestion_absences', { 
            enseignants, 
            ghaibeen, 
            suggestions, 
            today, 
            recapSubstitutions, 
            titre: "توزيع حصص الاحتياط" 
        });

    } catch (e) { 
        console.error(e);
        res.status(500).send("خطأ في نظام الاحتياط: " + e.message); 
    }
});

    app.post('/admin/absences/ajouter', async (req, res) => {
        try {
            const { enseignant_id, date, raison } = req.body;
            const existing = (await pool.query("SELECT id FROM absences WHERE enseignant_id = $1 AND date = $2", [enseignant_id, date])).rows[0];
            if (!existing) {
                await pool.query("INSERT INTO absences (enseignant_id, date, raison, status) VALUES ($1, $2, $3, 'confirmed')", [enseignant_id, date, raison]);
            }
            res.redirect('/admin/absence-profs?success=absence_added');
        } catch (e) { res.status(500).send("فشل تسجيل الغياب"); }
    });

    // --- [ 7. إدارة الطلاب ] ---

    app.get('/admin/eleves', async (req, res) => {
    try {
        // تم تغيير students إلى eleves لتطابق قاعدة بياناتك
        const eleves = (await pool.query("SELECT * FROM students ORDER BY classe, section, nom")).rows;
        
        const classes = (await pool.query("SELECT * FROM school_classes")).rows;
        
        // تأكد أن اسم الملف gestion_eleves.ejs هو الاسم الصحيح لملف التصميم
        res.render('gestion_eleves', { 
            eleves, 
            classes, 
            titre: "إدارة سجلات الطلاب" 
        });
    } catch (e) { 
        console.error("Error loading students:", e.message);
        res.status(500).send("خطأ في تحميل سجل الطلاب"); 
    }
});

   app.post('/admin/eleves/ajouter', async (req, res) => {
    try {
        const { nom, class_info, parent_phone } = req.body;
        const [classe, section] = class_info.split('|');
        // الإضافة في students
        await pool.query("INSERT INTO students (nom, classe, section, parent_phone) VALUES ($1, $2, $3, $4)", [nom, classe, section, parent_phone]);
        res.redirect('/admin/eleves?success=added');
    } catch (e) {
        res.redirect('/admin/eleves?error=add_failed');
    }
});

    app.post('/admin/eleves/modifier', async (req, res) => {
        try {
            const { id, nom, class_info, parent_phone } = req.body;
            const [classe, section] = class_info.split('|');
            await pool.query("UPDATE students SET nom = $1, classe = $2, section = $3, parent_phone = $4 WHERE id = $5", [nom, classe, section, parent_phone, id]);
            res.redirect('/admin/eleves?success=updated');
        } catch (e) { res.redirect('/admin/eleves?error=update_failed'); }
    });
//222222222222
   // --- [ 11. رصد غياب الطلاب والسلوك (من جهة المعلم) ] ---

app.get('/teacher/absences/check-status', async (req, res) => {
    const { classe, section, date } = req.query;
    const check = await pool.query(
        `SELECT sa.id FROM student_absences sa
         JOIN students s ON sa.eleve_id = s.id
         WHERE s.classe = $1 AND s.section = $2 AND sa.date = $3 LIMIT 1`,
        [classe, section, date]
    );
    res.json({ alreadyMarked: check.rows.length > 0 });
});



app.post('/teacher/absences/mark', async (req, res) => {
    let { enseignant_id, date, periode, eleve_ids } = req.body;

    try {
        // 1. التحقق من البيانات الأساسية وتصحيح التاريخ
        if (!enseignant_id || enseignant_id === 'undefined') {
            return res.status(400).send("معرف المعلم مفقود");
        }
        const teacherIdInt = parseInt(enseignant_id);

        if (!date || date.trim() === "") {
            date = new Date().toISOString().split('T')[0];
        }

        // 2. الحصول على بيانات الحصة من الجدول الدراسي (timetable)
        const sessionInfo = await pool.query(
            `SELECT classe, section 
             FROM timetable 
             WHERE enseignant_id = $1 
             AND jour = (
                SELECT CASE TRIM(to_char($2::date, 'Day'))
                    WHEN 'Sunday'    THEN 'الأحد'
                    WHEN 'Monday'    THEN 'الإثنين'
                    WHEN 'Tuesday'   THEN 'الثلاثاء'
                    WHEN 'Wednesday' THEN 'الأربعاء'
                    WHEN 'Thursday'  THEN 'الخميس'
                    WHEN 'Friday'    THEN 'الجمعة'
                    WHEN 'Saturday'  THEN 'السبت'
                END
             )
             AND periode = $3 
             LIMIT 1`,
            [teacherIdInt, date, periode]
        );

        if (sessionInfo.rows.length === 0) {
            return res.status(400).send("عذراً، لم يتم العثور على حصة مسجلة لك في هذا الوقت.");
        }

        // استخراج القيم الأصلية (تكون غالباً أرقام مثل 8 و 2)
        const rawClasse = sessionInfo.rows[0].classe; 
        const section = sessionInfo.rows[0].section;

        // 3. تحويل رقم الصف إلى نص عربي ليطابق عمود s.classe في جدول الطلاب
        const classMap = {
            '5': 'خامس', '6': 'سادس', '7': 'سابع', '8': 'ثامن', '9': 'تاسع', '10': 'عاشر'
        };
        const dbClassName = classMap[rawClasse] || rawClasse;

        // 4. القفل الذهبي: التحقق هل رصد أي معلم آخر غياب هذا الفصل اليوم؟
        const alreadyMarked = await pool.query(
            `SELECT sa.id 
             FROM student_absences sa
             JOIN students s ON sa.eleve_id = s.id
             WHERE s.classe = $1 
             AND s.section = $2 
             AND sa.date = $3
             LIMIT 1`,
            [dbClassName, section, date] // نستخدم dbClassName (ثامن) بدلاً من rawClasse (8)
        );

        if (alreadyMarked.rows.length > 0) {
            // السماح بالتعديل فقط إذا كان نفس المعلم ونفس الحصة
            const isSameSession = await pool.query(
                `SELECT id FROM student_absences 
                 WHERE date = $1 AND periode = $2 AND enseignant_id = $3 LIMIT 1`,
                [date, periode, teacherIdInt]
            );

            if (isSameSession.rows.length === 0) {
                return res.status(403).send(`❌ عذراً، تم رصد غياب فصل ${dbClassName}-${section} مسبقاً اليوم.`);
            }
        }

        // 5. مسح السجلات القديمة لهذه الحصة فقط تمهيداً للإضافة الجديدة
        await pool.query(
            "DELETE FROM student_absences WHERE date = $1 AND periode = $2 AND enseignant_id = $3", 
            [date, periode, teacherIdInt]
        );
        
        // 6. إدخال الغياب الجديد
        if (eleve_ids && eleve_ids.length > 0) {
            const ids = Array.isArray(eleve_ids) ? eleve_ids : [eleve_ids];
            for (let id of ids) {
                await pool.query(
                    "INSERT INTO student_absences (eleve_id, enseignant_id, date, periode) VALUES ($1, $2, $3, $4)", 
                    [parseInt(id), teacherIdInt, date, periode]
                );
            }
        } 

        // 7. منح النجمة للمعلم
        const starUpdate = await pool.query(
            "UPDATE enseignants SET stars_count = COALESCE(stars_count, 0) + 1 WHERE id = $1 RETURNING stars_count",
            [teacherIdInt]
        );
        
        console.log(`✅ تم الحفظ. فصل: ${dbClassName}-${section}. رصيد النجوم: ${starUpdate.rows[0].stars_count}`);

        res.redirect(`/teacher/dashboard/${teacherIdInt}?success=attendance_saved&p=${periode}`);
        
    } catch (e) {
        console.error("خطأ أثناء الحفظ:", e);
        res.status(500).send("فشل حفظ الغياب: " + e.message);
    }
});

    app.post('/teacher/behavior/add', async (req, res) => {
        const { student_id, teacher_id, event_text } = req.body;
        const today = new Date().toISOString().split('T')[0];
        try {
            await pool.query("INSERT INTO behavior_logs (student_id, teacher_id, event, date) VALUES ($1, $2, $3, $4)", 
                [student_id, teacher_id, event_text, today]);
            res.redirect(`/teacher/dashboard/${teacher_id}?success=behavior_added`);
        } catch (e) {
            res.status(500).send("خطأ في تسجيل الملاحظة السلوكية");
        }
    });

    // --- [ الخروج ] ---

    app.get('/logout', (req, res) => {
        res.clearCookie('admin_auth');
        res.clearCookie('teacher_auth'); // تم إضافة مسح كوكيز المعلم أيضاً
        res.redirect('/teacher/login');
    });

    // --- [ إدارة الاحتياط المتقدمة - الإلغاء والحذف ] ---

    app.get('/admin/substitute/delete/:id', async (req, res) => {
        try {
            const sub_id = req.params.id;
            const reason = req.query.reason; 
            const today = new Date().toISOString().split('T')[0];

            const subEntry = (await pool.query("SELECT absent_id FROM substitute_logs WHERE id = $1", [sub_id])).rows[0];

            if (subEntry) {
                await pool.query("DELETE FROM substitute_logs WHERE id = $1", [sub_id]);

                if (reason === 'present') {
                    // إذا حضر المعلم، نحذف سجل غيابه ليعود متاحاً في الجدول
                    await pool.query("DELETE FROM absences WHERE enseignant_id = $1 AND date = $2", [subEntry.absent_id, today]);
                }
            }

            let message = (reason === 'present') ? 'teacher_present' : 'substitute_cancelled';
            res.redirect(`/admin/absence-profs?success=${message}`);
        } catch (e) {
            res.status(500).send("خطأ في معالجة طلب الحذف");
        }
    });

    app.post('/admin/enseignants/affecter-multiple', async (req, res) => {
    const { enseignant_id, classes_data } = req.body;
    try {
        // التحقق مما إذا كانت البيانات مصفوفة أم نص يحتاج تحويل
        const selectedClasses = Array.isArray(classes_data) ? classes_data : JSON.parse(classes_data);
        
        const teacherRes = await pool.query("SELECT nom, matiere FROM enseignants WHERE id = $1", [enseignant_id]);
        const currentTeacher = teacherRes.rows[0];
        
        if (!currentTeacher) return res.status(404).json({ message: "المعلم غير موجود" });

        for (const item of selectedClasses) {
            const [classe, section] = item.split('|');

            // 1. التحقق من وجود تعارض لنفس المادة في نفس الفصل
            const conflictRes = await pool.query(`
                SELECT e.nom FROM affectations a 
                JOIN enseignants e ON a.enseignant_id = e.id 
                WHERE a.classe = $1 AND a.section = $2 AND e.matiere = $3
            `, [classe, section, currentTeacher.matiere]);
            
            const conflict = conflictRes.rows[0];

            if (conflict) {
                return res.status(400).json({ 
                    message: `خطأ: الفصل ${classe} (${section}) مسند بالفعل لمدرس مادة ${currentTeacher.matiere} آخر وهو: ${conflict.nom}` 
                });
            }

            // 2. التحقق من عدم تكرار نفس المعلم لنفس الفصل
            const existsRes = await pool.query(
                "SELECT id FROM affectations WHERE enseignant_id = $1 AND classe = $2 AND section = $3", 
                [enseignant_id, classe, section]
            );
            
            if (existsRes.rows.length === 0) {
                await pool.query(
                    "INSERT INTO affectations (enseignant_id, classe, section) VALUES ($1, $2, $3)", 
                    [enseignant_id, classe, section]
                );
            }
        }
        // إرسال رد نجاح بصيغة JSON
        res.status(200).json({ message: "تم التعيين بنجاح" });
    } catch (e) { 
        console.error(e);
        res.status(500).json({ message: "خطأ داخلي في السيرفر" }); 
    }
});

// --- [ Timetable Routes ] ---

// 1. الصفحة الرئيسية للجدول (تحميل الواجهة فقط)
app.get('/admin/timetable', isAdmin, async (req, res) => {
    try {
        const enseignants = await pool.query("SELECT * FROM enseignants ORDER BY nom");
        const classes = await pool.query("SELECT DISTINCT classe, section FROM affectations ORDER BY classe");
        const affectations = await pool.query(`
            SELECT a.*, e.nom as prof_nom, e.matiere 
            FROM affectations a 
            JOIN enseignants e ON a.enseignant_id = e.id
        `);
        const schedule = await pool.query(`
            SELECT t.*, e.nom as prof_nom, e.matiere 
            FROM timetable t 
            JOIN enseignants e ON t.enseignant_id = e.id
        `);

        // التعديل هنا: حذف 'admin/' لأن الملف في مجلد views مباشرة
        res.render('gestion_timetable', {
            titre: "إدارة الجدول",
            enseignants: enseignants.rows,
            unique_classes: classes.rows,
            all_affectations: affectations.rows,
            schedule: schedule.rows,
            teacher_filter: null,
            class_filter: null
        });
    } catch (error) {
        console.error("خطأ في جلب بيانات الجدول:", error);
        res.status(500).send("حدث خطأ في السيرفر");
    }
});

// 2. مسار جلب البيانات المحدثة (API)
app.get('/admin/timetable/data', isAdmin, async (req, res) => {
    try {
        const schedule = await pool.query(`
            SELECT t.*, e.nom as prof_nom, e.matiere 
            FROM timetable t 
            JOIN enseignants e ON t.enseignant_id = e.id
        `);
        res.json({ schedule: schedule.rows });
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch data" });
    }
});

// 3. مسار الإضافة (Drag & Drop API)
app.post('/admin/timetable/ajouter-json', isAdmin, async (req, res) => {
    try {
        const { enseignant_id, class_info, jour, periode } = req.body;
        
        // فك ضغط بيانات الصف (مثلاً: "1|A" تصبح classe=1 و section=A)
        const [classe, section] = class_info.split('|');

        // التحقق من تعارض المعلم
        const checkTeacher = await pool.query(
            "SELECT * FROM timetable WHERE enseignant_id = $1 AND jour = $2 AND periode = $3",
            [enseignant_id, jour, periode]
        );
        if (checkTeacher.rows.length > 0) {
            return res.json({ success: false, message: "⚠️ المعلم مشغول في هذا الوقت!" });
        }

        // التحقق من تعارض الصف
        const checkClass = await pool.query(
            "SELECT * FROM timetable WHERE classe = $1 AND section = $2 AND jour = $3 AND periode = $4",
            [classe, section, jour, periode]
        );
        if (checkClass.rows.length > 0) {
            return res.json({ success: false, message: "⚠️ هذا الصف لديه حصة أخرى بالفعل!" });
        }

        // الإضافة الفعلية
        await pool.query(
            "INSERT INTO timetable (enseignant_id, classe, section, jour, periode) VALUES ($1, $2, $3, $4, $5)",
            [enseignant_id, classe, section, jour, periode]
        );

        // أهم سطر لإلغاء حالة "جاري الحفظ"
        res.json({ success: true, message: "✅ تم حفظ الحصة بنجاح" });

    } catch (error) {
        console.error(error);
        res.json({ success: false, message: "حدث خطأ في السيرفر" });
    }
});


// مسار حذف حصة عبر AJAX (JSON)
app.delete('/admin/timetable/supprimer-json/:id', isAdmin, async (req, res) => {
    try {
        const sessionId = req.params.id;

        // 1. تنفيذ عملية الحذف في قاعدة البيانات
        const result = await pool.query("DELETE FROM timetable WHERE id = $1", [sessionId]);

        // 2. التحقق مما إذا تم الحذف فعلاً (في حال كانت الحصة محذوفة مسبقاً)
        if (result.rowCount > 0) {
            return res.json({ 
                success: true, 
                message: "🗑️ تم حذف الحصة وتفريغ الوقت بنجاح" 
            });
        } else {
            return res.json({ 
                success: false, 
                message: "⚠️ لم يتم العثور على الحصة، ربما تم حذفها بالفعل" 
            });
        }

    } catch (error) {
        console.error("Error deleting session:", error);
        res.status(500).json({ 
            success: false, 
            message: "❗ حدث خطأ فني أثناء محاولة الحذف" 
        });
    }
});
app.post('/admin/timetable/ajouter-json', isAdmin, async (req, res) => {
    try {
        const { enseignant_id, class_info, jour, periode } = req.body;
        
        if (!enseignant_id || !class_info || !jour || !periode) {
            return res.json({ success: false, message: "⚠️ بيانات غير مكتملة" });
        }

        const [classe, section] = class_info.split('|');

        // (بقيت التحققات كما هي دون تغيير...)

        // التعديل هنا: أضفنا RETURNING id للحصول على المعرف الذي تم إنشاؤه تلقائياً
        const insertResult = await pool.query(
            "INSERT INTO timetable (enseignant_id, classe, section, jour, periode) VALUES ($1, $2, $3, $4, $5) RETURNING id",
            [enseignant_id, classe, section, jour, periode]
        );

        // أرسل الـ id مع الرد
        res.json({ 
            success: true, 
            message: "✅ تم تثبيت الحصة في الجدول بنجاح",
            id: insertResult.rows[0].id // هذا هو السطر المفتاحي
        });

    } catch (error) {
        console.error("Timetable Error:", error);
        res.status(500).json({ success: false, message: "❗ خطأ فني في قاعدة البيانات" });
    }
});

app.delete('/admin/timetable/supprimer-json/:id', isAdmin, async (req, res) => {
    try {
        const result = await pool.query("DELETE FROM timetable WHERE id = $1", [req.params.id]);
        
        if (result.rowCount > 0) {
            res.json({ success: true, message: "🗑️ تم حذف الحصة وتفريغ الوقت بنجاح" });
        } else {
            res.json({ success: false, message: "⚠️ لم يتم العثور على الحصة المراد حذفها" });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: "❗ حدث خطأ أثناء محاولة الحذف" });
    }
});




    /*
    app.get('/admin/timetable/supprimer/:id', async (req, res) => {
        try {
            await pool.query("DELETE FROM timetable WHERE id = $1", [req.params.id]);
            res.redirect('/admin/timetable?success=deleted');
        } catch (e) {
            res.redirect('/admin/timetable?error=delete_failed');
        }
    });
    */
    

    // --- [ التقارير الشاملة ] ---

    app.get('/admin/student/full-report/:id', async (req, res) => {
        try {
            const studentId = req.params.id;
            const student = (await pool.query("SELECT * FROM students WHERE id = $1", [studentId])).rows[0];
            if (!student) return res.status(404).send("الطالب غير موجود");

            const absences = (await pool.query("SELECT * FROM student_absences WHERE eleve_id = $1", [studentId])).rows;
            const behaviors = (await pool.query("SELECT date AS created_at, event AS event_text FROM behavior_logs WHERE student_id = $1", [studentId])).rows;
            const evaluations = (await pool.query(`
                SELECT ae.*, e.nom as teacher_name 
                FROM academic_evaluations ae
                JOIN enseignants e ON ae.enseignant_id = e.id
                WHERE ae.eleve_id = $1`, [studentId])).rows;

            res.render('student_report', { student, absences, behaviors, evaluations, titre: "تقرير الطالب الشامل" });
        } catch (e) {
            res.status(500).send("خطأ أثناء استخراج التقرير");
        }
    });

    app.get('/admin/student-reports-list', async (req, res) => {
        try {
            const studentsWithEvals = (await pool.query(`
                SELECT DISTINCT e.id, e.nom, e.classe, e.section 
                FROM students e JOIN academic_evaluations ae ON e.id = ae.eleve_id`)).rows;
            const all_students = (await pool.query("SELECT id, nom, classe FROM students ORDER BY nom ASC")).rows;
            
            res.render('admin_evaluations_list', { 
                students: studentsWithEvals, 
                all_students: all_students, 
                titre: "إدارة التقييمات الأكاديمية" 
            });
        } catch (e) {
            res.status(500).send("خطأ في جلب قائمة التقييمات");
        }
    });

    // توحيد المسارات
app.get('/admin/students', (req, res) => res.redirect('/admin/eleves'));

app.get('/admin/eleves', async (req, res) => {
    try {
        // نستخدم students لأنه الجدول المرتبط بالغياب والسلوك
        const students = (await pool.query("SELECT * FROM students ORDER BY classe, section, nom")).rows;
        const classes = (await pool.query("SELECT * FROM school_classes")).rows;
        
        // نرسل البيانات تحت اسم 'eleves' لكي لا نغير أي شيء في ملف الـ EJS
        res.render('gestion_eleves', { eleves: students, classes, titre: "إدارة سجلات الطلاب" });
    } catch (e) {
        res.status(500).send("خطأ في تحميل سجل الطلاب");
    }
});



    // --- [ إضافة مسارات لوحة المعلم الكاملة ] ---



// مسار قبول أو رفض حصة الاحتياط من قبل المعلم
app.post('/teacher/substitute/respond', async (req, res) => {
    try {
        const { sub_id, action, teacher_id } = req.body;

        // إذا لم يصل المعرف من النموذج، نحاول أخذه من الجلسة
        const finalTeacherId = teacher_id || req.session.teacherId;

        if (!finalTeacherId || finalTeacherId === 'undefined') {
            console.error("لم يتم العثور على معرف المعلم");
            // بدلاً من /login، نعود لآخر صفحة كان فيها المعلم
            return res.status(400).send("خطأ: لم يتم التعرف على هوية المعلم. يرجى تحديث الصفحة.");
        }

        const newStatus = (action === 'accept') ? 'accepted' : 'rejected';
        
        // تحديث قاعدة البيانات
        await pool.query(
            "UPDATE substitute_logs SET status = $1 WHERE id = $2",
            [newStatus, sub_id]
        );

        console.log(`تم تحديث الحصة ${sub_id} إلى ${newStatus} للمعلم ${finalTeacherId}`);

        // العودة للوحة التحكم
        res.redirect(`/teacher/dashboard/${finalTeacherId}`);

    } catch (e) {
        console.error("خطأ في السيرفر:", e);
        res.status(500).send("حدث خطأ داخلي");
    }
});
// --- [ إضافة مسارات الإعدادات الكاملة ] ---

app.get('/admin/settings', isAdmin, async (req, res) => {
    try {
        // تحديث النصاب الأسبوعي تلقائياً عند الدخول للصفحة
        await pool.query("UPDATE enseignants SET weekly_load = (SELECT COUNT(*) FROM timetable WHERE enseignant_id = enseignants.id)");

        const teachers = (await pool.query("SELECT * FROM enseignants ORDER BY nom ASC")).rows;
        const classes = (await pool.query("SELECT * FROM school_classes ORDER BY class_name ASC")).rows;
        const subjects = (await pool.query("SELECT * FROM school_subjects ORDER BY name ASC")).rows;
        const periods = (await pool.query("SELECT * FROM school_periods ORDER BY id ASC")).rows;

        res.render('admin_settings', {
            teachers,
            classes,
            subjects,
            periods,
            titre: "إعدادات النظام"
        });
    } catch (e) {
        res.status(500).send("خطأ في تحميل الإعدادات");
    }
});

// مسار إضافة فصل دراسي
app.post('/admin/classes/add', isAdmin, async (req, res) => {
    try {
        const { class_name, num_sections } = req.body;
        await pool.query("INSERT INTO school_classes (class_name, num_sections) VALUES ($1, $2) ON CONFLICT (class_name) DO NOTHING", [class_name, num_sections]);
        res.redirect('/admin/settings?success=class_added');
    } catch (e) { res.status(500).send("خطأ في إضافة الفصل"); }
});

// مسار إضافة مادة دراسية
app.post('/admin/subjects/add', isAdmin, async (req, res) => {
    try {
        const { subject_name } = req.body;
        await pool.query("INSERT INTO school_subjects (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [subject_name]);
        res.redirect('/admin/settings?success=subject_added');
    } catch (e) { res.status(500).send("خطأ في إضافة المادة"); }
});

// 1. مسار عرض صفحة دخول المعلم
app.get('/teacher/login', async (req, res) => {
    try {
        // جلب المواد من جدول school_subjects (الحقل هو name)
        const subjectsResult = await pool.query("SELECT name FROM school_subjects ORDER BY name ASC");
        
        // جلب المعلمين مع مادتهم (الحقل هو matiere)
        const teachersResult = await pool.query("SELECT id, nom, matiere FROM enseignants ORDER BY nom ASC");

        res.render('teacher_login', { 
            matieres: subjectsResult.rows, 
            enseignants: teachersResult.rows, 
            error: null 
        });
    } catch (e) {
        console.error(e);
        res.status(500).send("خطأ في جلب البيانات");
    }
});
// 2. مسار استقبال وإضافة مادة دراسية جديدة
// 1. مسار إضافة مادة دراسية - مطابق لملف EJS
app.post('/admin/settings/subjects/add', isAdmin, async (req, res) => {
    try {
        // نستخدم subject_name كما هو موجود في الـ input بملف الـ EJS
        const { subject_name } = req.body;

        if (!subject_name || subject_name.trim() === "") {
            return res.status(400).send("خطأ: اسم المادة مطلوب");
        }

        await pool.query(
            "INSERT INTO school_subjects (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", 
            [subject_name.trim()]
        );

        res.redirect('/admin/settings?success=subject_added');
    } catch (e) {
        console.error(e);
        res.status(500).send("خطأ في الخادم أثناء إضافة المادة");
    }
});

// 2. مسار حذف مادة دراسية
app.post('/admin/settings/subjects/delete', isAdmin, async (req, res) => {
    try {
        const { id } = req.body;
        await pool.query("DELETE FROM school_subjects WHERE id = $1", [id]);
        res.redirect('/admin/settings?success=subject_deleted');
    } catch (e) {
        res.status(500).send("خطأ أثناء حذف المادة");
    }
});


// 3. تحديث بيانات المعلم (الرتبة والالتزام والنصاب)
app.post('/admin/settings/teachers/update-policy', isAdmin, async (req, res) => {
    try {
        const { teacher_id, rank, weekly_load, is_admin_duty } = req.body;
        
        // تحويل حالة الـ checkbox (إذا وصل فهو موجود، وإلا فهو 0)
        const adminDutyValue = is_admin_duty ? 1 : 0;

        await pool.query(
            `UPDATE enseignants 
             SET rank = $1, weekly_load = $2, is_admin_duty = $3 
             WHERE id = $4`,
            [rank, weekly_load, adminDutyValue, teacher_id]
        );

        res.redirect('/admin/settings?success=policy_updated');
    } catch (e) {
        console.error(e);
        res.status(500).send("خطأ في تحديث بيانات المعلم");
    }
});
// 4. إضافة فصل دراسي جديد
app.post('/admin/settings/classes/add', isAdmin, async (req, res) => {
    try {
        const { class_name, num_sections } = req.body;

        if (!class_name) {
            return res.status(400).send("اسم الفصل مطلوب");
        }

        // إدخال البيانات في جدول school_classes
        await pool.query(
            "INSERT INTO school_classes (class_name, num_sections) VALUES ($1, $2) ON CONFLICT (class_name) DO NOTHING", 
            [class_name, num_sections || 1]
        );

        res.redirect('/admin/settings?success=class_added');
    } catch (e) {
        console.error(e);
        res.status(500).send("خطأ في إضافة الفصل");
    }
});
// 5. حذف فصل دراسي
app.post('/admin/settings/classes/delete', isAdmin, async (req, res) => {
    try {
        const { class_id } = req.body;
        
        // حذف الفصل من قاعدة البيانات
        await pool.query("DELETE FROM school_classes WHERE id = $1", [class_id]);
        
        res.redirect('/admin/settings?success=class_deleted');
    } catch (e) {
        console.error(e);
        res.status(500).send("خطأ أثناء حذف الفصل");
    }
});
// 6. تحديث كلمة مرور معلم
app.post('/admin/settings/password/update', isAdmin, async (req, res) => {
    try {
        const { teacher_id, new_password } = req.body;

        if (!new_password) return res.status(400).send("كلمة المرور مطلوبة");

        await pool.query(
            "UPDATE enseignants SET password = $1 WHERE id = $2",
            [new_password, teacher_id]
        );

        res.redirect('/admin/settings?success=password_updated');
    } catch (e) {
        res.status(500).send("خطأ في تحديث كلمة المرور");
    }
});
// مسار خاص بالمعلم لتغيير كلمته بنفسه
app.post('/teacher/update-my-password', async (req, res) => {
    try {
        const teacher_id = req.cookies.teacher_auth; // استخراج المعرف من الكوكيز
        const { new_password } = req.body;

        if (!teacher_id) return res.status(401).send("غير مصرح لك");
        if (!new_password) return res.status(400).send("كلمة المرور مطلوبة");

        await pool.query(
            "UPDATE enseignants SET password = $1 WHERE id = $2",
            [new_password, teacher_id]
        );

        res.send("<script>alert('تم تحديث كلمتك بنجاح'); window.location.href='/teacher/dashboard/" + teacher_id + "';</script>");
    } catch (e) {
        res.status(500).send("خطأ في التحديث");
    }
});

// 7. تحديث توقيت الحصص المدرسية
// --- Route: الاعتماد النهائي ونقل البيانات للجدول الرسمي ---
app.post('/admin/settings/periods/update', async (req, res) => {
    // استلام مصفوفات الأوقات من النموذج (Form)
    let { start_time, end_time } = req.body;

    try {
        await pool.query("BEGIN");

        // 1. مسح التوقيت الرسمي القديم
        await pool.query("DELETE FROM school_periods");

        // 2. التأكد أن البيانات مصفوفة (حتى لو أرسل المتصفح قيمة واحدة)
        if (!Array.isArray(start_time)) start_time = [start_time];
        if (!Array.isArray(end_time)) end_time = [end_time];

        // 3. إدخال الأوقات الجديدة في الجدول الرسمي school_periods
        for (let i = 0; i < start_time.length; i++) {
            if (start_time[i] && end_time[i]) {
                await pool.query(
                    "INSERT INTO school_periods (id, start_time, end_time) VALUES ($1, $2, $3)",
                    [i + 1, start_time[i], end_time[i]]
                );
            }
        }

        await pool.query("COMMIT");
        
        // إعادة التوجيه مع رسالة نجاح (إذا كنت تستخدم flash)
        // أو ببساطة العودة لصفحة الإعدادات
        res.redirect('/admin/settings?success=updated');

    } catch (err) {
        await pool.query("ROLLBACK");
        console.error("خطأ أثناء اعتماد التوقيت الرسمي:", err.message);
        res.status(500).send("فشل تحديث التوقيت الرسمي في قاعدة البيانات");
    }
});
// 8. التحقق من بيانات دخول المعلم
app.post('/teacher/login', async (req, res) => {
    const { teacher_id, password } = req.body;
    
    try {
        const result = await pool.query("SELECT * FROM enseignants WHERE id = $1", [teacher_id]);
        const teacher = result.rows[0];

        if (teacher && teacher.password === password) {
            // تحديث وقت آخر دخول (اختياري حسب جدولك)
            const now = new Date().toLocaleString('ar-OM');
            await pool.query("UPDATE enseignants SET last_login = $1 WHERE id = $2", [now, teacher.id]);

            // إنشاء الكوكيز للجلسة
            res.cookie('teacher_auth', teacher.id, { httpOnly: true });
            return res.redirect(`/teacher/dashboard/${teacher.id}`);
        } else {
            // إعادة عرض الصفحة مع رسالة خطأ
            const allTeachers = await pool.query("SELECT * FROM enseignants ORDER BY nom ASC");
            return res.render('teacher_login', { 
                error: "كلمة المرور غير صحيحة أو المعلم غير موجود", 
                enseignants: allTeachers.rows,
                titre: "دخول المعلمين"
            });
        }
    } catch (e) {
        console.error(e);
        res.status(500).send("خطأ داخلي في النظام");
    }
});
// يجب أن يكون المسار بهذا الشكل لاستقبال الـ ID
// app.js
app.get('/teacher/dashboard/:id', async (req, res) => {
    try {
        // 1. استخراج المعرف أولاً لاستخدامه في الاستعلامات
        const teacherId = req.params.id;

        // 2. استعلام سجل النجوم (تم وضعه هنا لضمان عمل teacherId)
      const starHistoryRes = await pool.query(`
    SELECT * FROM (
        (SELECT 'تقييم طالب' as reason, date_submission as date, '1+' as points, id FROM academic_evaluations WHERE enseignant_id = $1)
        UNION ALL
        (SELECT DISTINCT ON (date, periode) 'رصد غياب حصة' as reason, date as date, '1+' as points, MAX(id) as id 
         FROM student_absences WHERE enseignant_id = $1 GROUP BY date, periode)
        UNION ALL
        (SELECT reason, date, points, id FROM star_logs WHERE enseignant_id = $1)
    ) AS combined_history
    ORDER BY date DESC, id DESC 
    LIMIT 5
`, [teacherId]);

        // التأكد من التاريخ بتوقيت عمان (Asia/Muscat)
        const today = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Muscat',
            year: 'numeric', month: '2-digit', day: '2-digit'
        }).format(new Date());

        const profRes = await pool.query("SELECT * FROM enseignants WHERE id = $1", [teacherId]);
        const prof = profRes.rows[0];

        const timetableRes = await pool.query("SELECT * FROM timetable WHERE enseignant_id = $1", [teacherId]);
        const periodsRes = await pool.query("SELECT * FROM school_periods ORDER BY id ASC");
        const elevesRes = await pool.query("SELECT * FROM students ORDER BY nom ASC");
        const annRes = await pool.query("SELECT * FROM announcements ORDER BY id DESC");
        
        const evalRes = await pool.query(`
            SELECT 
                er.*, 
                s.nom AS student_name, 
                s.classe 
            FROM evaluation_requests er
            JOIN students s ON er.eleve_id = s.id
            WHERE er.enseignant_id = $1 AND er.status = 'pending'
        `, [teacherId]);

        const locksRes = await pool.query(`
            SELECT DISTINCT 
                s.classe, 
                s.section, 
                e.nom as teacher_name, 
                sa.enseignant_id,
                sa.periode
            FROM student_absences sa
            JOIN students s ON sa.eleve_id = s.id
            JOIN enseignants e ON sa.enseignant_id = e.id
            WHERE sa.date = $1
        `, [today]);

        const markedPeriods = locksRes.rows
            .filter(l => l.enseignant_id == teacherId)
            .map(l => l.periode);

        const subRes = await pool.query(
            "SELECT * FROM substitute_logs WHERE substitute_id = $1 AND date = $2",
            [teacherId, today]
        );

        // 3. إرسال كافة البيانات المطلوبة للـ EJS مع إضافة starHistory
        res.render('teacher_dashboard', {
            titre: "لوحة التحكم",
            prof: prof,
            timetable: timetableRes.rows,
            school_periods: periodsRes.rows,
            eleves: elevesRes.rows,
            announcements: annRes.rows,
            evaluation_requests: evalRes.rows,
            substitute_logs: subRes.rows,
            markedPeriods: markedPeriods,
            classLocks: locksRes.rows,
            starHistory: starHistoryRes.rows // <<< القيمة الجديدة المضافة للـ EJS
        });

    } catch (e) {
        console.error("خطأ في السيرفر:", e);
        res.status(500).send("خطأ في تحميل لوحة التحكم: " + e.message);
    }
});
// 10. إضافة إعلان جديد من قبل الإدارة
app.post('/admin/announcements/add', isAdmin, async (req, res) => {
    try {
        // أضفنا priority هنا لأنها موجودة في جدولك
        const { title, content, priority } = req.body; 
        
        // ملاحظة: الـ Schema الخاص بك يحدد النوع text للعمود date
        const date = new Date().toLocaleDateString('ar-EG');

        if (!title || !content) {
            return res.status(400).send("العنوان والمحتوى مطلوبان");
        }

        // التصحيح: إضافة عمود priority في الاستعلام والقيم
        await pool.query(
            "INSERT INTO announcements (title, content, date, priority) VALUES ($1, $2, $3, $4)",
            [title, content, date, priority || 'normal'] // 'normal' كقيمة افتراضية إذا لم تُرسل
        );

        res.redirect('/admin/dashboard?success=announcement_posted');
    } catch (e) {
        console.error("Error adding announcement:", e);
        res.status(500).send("خطأ في نشر الإعلان");
    }
});
// 11. تكليف معلم بحصة احتياط (من قبل الإدارة)
app.post('/admin/substitute/assign-session', isAdmin, async (req, res) => {
    try {
        let { absent_id, substitute_id, periode, classe, section } = req.body;

        // 1. إصلاح التاريخ ليكون بتوقيتك المحلي (Asia/Muscat)
        const todayDate = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Muscat',
            year: 'numeric', month: '2-digit', day: '2-digit'
        }).format(new Date());

        // 2. إصلاح اسم اليوم ليكون مطابقاً للتوقيت المحلي
        const days = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
        const localDate = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Muscat"}));
        const todayName = days[localDate.getDay()];

        if (!substitute_id) {
            // البحث التلقائي باستخدام اليوم الصحيح
            const autoRes = await pool.query(`
                SELECT id FROM enseignants 
                WHERE id NOT IN (
                    SELECT enseignant_id FROM timetable 
                    WHERE periode = $1 AND (jour = $2 OR jour = REPLACE($2, 'إ', 'ا'))
                )
                AND id != $3
                AND id NOT IN (SELECT enseignant_id FROM absences WHERE date = $4)
                ORDER BY monthly_reserve ASC, weekly_load ASC 
                LIMIT 1`, [periode, todayName, absent_id, todayDate]);
            
            if (autoRes.rows.length === 0) {
                return res.redirect('/admin/absence-profs?error=no_teacher');
            }
            substitute_id = autoRes.rows[0].id;
        }

        // 3. إدخال السجل بالتاريخ المحلي الصحيح
        await pool.query(
            `INSERT INTO substitute_logs (absent_id, substitute_id, periode, classe, section, date, status) 
             VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
            [absent_id, substitute_id, periode, classe, section, todayDate]
        );

        await pool.query("UPDATE enseignants SET monthly_reserve = COALESCE(monthly_reserve, 0) + 1 WHERE id = $1", [substitute_id]);

        res.redirect('/admin/absence-profs?success=assigned');
    } catch (e) {
        console.error("خطأ في التوزيع:", e);
        res.redirect('/admin/absence-profs?error=db_error');
    }
});

app.get('/admin/substitute', isAdmin, async (req, res) => {
    try {
        const days = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
        const todayName = days[new Date().getDay()];
        // تأكد من تنسيق التاريخ بصيغة YYYY-MM-DD
        const todayDate = new Date().toISOString().split('T')[0];

        // 1. جلب المعلمين الغائبين
        const ghaibeenRes = await pool.query(`
            SELECT t.*, e.nom, e.matiere, e.id as teacher_id
            FROM timetable t
            JOIN enseignants e ON t.enseignant_id = e.id
            JOIN daily_absences da ON e.id = da.enseignant_id
            WHERE da.date::date = $1::date 
            AND (t.jour = $2 OR t.jour = REPLACE($2, 'إ', 'ا'))
            AND NOT EXISTS (
                SELECT 1 FROM substitute_logs sl 
                WHERE sl.absent_id = e.id 
                AND sl.periode = t.periode 
                AND sl.date::date = $1::date
            )
            ORDER BY t.periode ASC`, [todayDate, todayName]);

        // 2. جلب الحصص المغطاة
        const recapRes = await pool.query(`
            SELECT sl.*, e1.nom as absent_name, e2.nom as substitute_name
            FROM substitute_logs sl
            JOIN enseignants e1 ON sl.absent_id = e1.id
            JOIN enseignants e2 ON sl.substitute_id = e2.id
            WHERE sl.date::date = $1::date`, [todayDate]);

        // 3. جلب مقترحات البدلاء (البحث عن معلمين ليس لديهم حصة في هذه الفترة)
        const suggestionsRes = await pool.query(`
            SELECT id, nom, COALESCE(monthly_reserve, 0) as reserve_this_month
            FROM enseignants
            ORDER BY monthly_reserve ASC LIMIT 10`);

        const allEnseignants = await pool.query("SELECT id, nom, matiere FROM enseignants ORDER BY nom ASC");

        res.render('gestion_absences', {
            ghaibeen: ghaibeenRes.rows || [],
            recapSubstitutions: recapRes.rows || [],
            suggestions: suggestionsRes.rows || [],
            enseignants: allEnseignants.rows || [],
            today: todayDate,
            titre: "إدارة الاحتياط"
        });
    } catch (e) {
        console.error("Critical Database Error:", e);
        res.status(500).send("خطأ في مطابقة البيانات: " + e.message);
    }
});
  app.post('/admin/absences/ajouter', isAdmin, async (req, res) => {
    try {
        const { enseignant_id, reason, date } = req.body;
        await pool.query(
            "INSERT INTO daily_absences (enseignant_id, reason, date) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
            [enseignant_id, reason, date]
        );
        res.redirect('/admin/substitute?success=absent_added');
    } catch (e) {
        res.status(500).send("خطأ في تسجيل الغياب");
    }
});


app.get('/admin/rapport-absences-eleves', async (req, res) => {
    try {
        const query = `
            SELECT 
                e.id, 
                e.nom, 
                e.classe, 
                e.section, 
                COUNT(DISTINCT a.date) as total_absences_days 
            FROM students e
            -- التغيير هنا: استخدمنا اسم الجدول الصحيح الذي يرسل له المعلم البيانات
            LEFT JOIN student_absences a ON e.id = a.eleve_id
            GROUP BY e.id, e.nom, e.classe, e.section
            ORDER BY total_absences_days DESC, e.classe ASC, e.nom ASC;
        `;
        
        const result = await pool.query(query);
        
        res.render('admin_rapport_absences', {
            rapports: result.rows,
            titre: "تقرير متابعة الغياب اليومي"
        });
    } catch (e) {
        console.error("Error in Absence Report:", e.message);
        res.status(500).send("خطأ في جلب البيانات");
    }
});

app.get('/admin/behavior-reports', async (req, res) => {
    try {
        const query = `
            SELECT 
                b.id, 
                e.nom as student_name, 
                e.classe, 
                e.section, 
                b.event as event_desc,
                p.nom as teacher_name, 
                b.date as date -- جلب التاريخ مباشرة كونه نص في قاعدة البيانات
            FROM behavior_logs b
            JOIN eleves e ON b.student_id = e.id
            JOIN enseignants p ON b.teacher_id = p.id
            ORDER BY b.id DESC -- الترتيب حسب المعرف الأحدث
        `;
        const result = await pool.query(query);
       // ابحث عن هذا السطر وقم بتعديله كالتالي:
res.render('admin_behaviors', {  // حذفنا _reports لتطابق اسم ملفك
    reports: result.rows,
    titre: "سجل الانضباط والسلوك"
});
    } catch (e) {
        console.error("خطأ في جلب تقرير السلوك:", e.message);
        res.status(500).send("خطأ في تحميل سجل الانضباط: " + e.message);
    }
});
// 1. مسار عرض التقارير


// 2. مسار حذف ملاحظة سلوكية
app.post('/admin/behavior/delete/:id', async (req, res) => {
    try {
        await pool.query("DELETE FROM behavior_logs WHERE id = $1", [req.params.id]);
        res.redirect('/admin/behavior-reports');
    } catch (e) {
        console.error("Error deleting report:", e.message);
        res.status(500).send("فشل في حذف الملاحظة");
    }
});
app.post('/admin/stars-management/update', async (req, res) => {
    try {
        const { teacher_id, stars_to_add, reason } = req.body;
        const today = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Muscat',
            year: 'numeric', month: '2-digit', day: '2-digit'
        }).format(new Date());

        // 1. زيادة النجوم في جدول المعلمين
        await pool.query(
            "UPDATE enseignants SET stars_count = COALESCE(stars_count, 0) + $1 WHERE id = $2",
            [parseInt(stars_to_add), teacher_id]
        );

        // 2. تسجيل العملية في جدول السجل ليراها المعلم
        await pool.query(
            "INSERT INTO star_logs (enseignant_id, reason, points, date) VALUES ($1, $2, $3, $4)",
            [teacher_id, reason || 'مكافأة إدارية', `+${stars_to_add}`, today]
        );

        res.json({ success: true, message: "تمت إضافة النجوم بنجاح" });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, error: e.message });
    }
});
// مسار عرض الصفحة (الذي يفتحه المتصفح)
app.get('/admin/stars-management', async (req, res) => {
    try {
        const query = `
            SELECT id, nom, stars_count, 
            CASE 
                WHEN stars_count >= 100 THEN 'معلم قدير'
                WHEN stars_count >= 50 THEN 'معلم متميز'
                ELSE 'معلم مبادر'
            END as rank_name
            FROM enseignants 
            ORDER BY stars_count DESC
        `;
        const result = await pool.query(query);
        
        res.render('admin_stars', { 
            teachers: result.rows, 
            titre: "لوحة شرف معلمين ابن دريد" 
        });
    } catch (e) {
        console.error(e);
        res.status(500).send("خطأ في عرض لوحة النجوم");
    }
});


// ب. مسار إضافة نقاط يدوية من الأدمن
app.post('/admin/stars/award', async (req, res) => {
    const { teacher_id, points, reason } = req.body;
    
    // الحصول على التاريخ الحالي بتوقيت عمان لضمان دقة السجل
    const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Muscat',
        year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());

    try {
        // 1. تحديث رصيد المعلم مع استخدام COALESCE لتجنب مشاكل القيم الفارغة
        await pool.query(
            "UPDATE enseignants SET stars_count = COALESCE(stars_count, 0) + $1 WHERE id = $2", 
            [parseInt(points), teacher_id]
        );

        // 2. تسجيل العملية في جدول السجل (stars_log) مع إضافة التاريخ والتنسيق
        // أضفنا علامة + قبل النقاط إذا كانت موجبة لتبدو أجمل في السجل
        const pointLabel = parseInt(points) > 0 ? `+${points}` : points;
        
        await pool.query(
            "INSERT INTO star_logs (enseignant_id, points, reason, date) VALUES ($1, $2, $3, $4)", 
            [teacher_id, pointLabel, reason, today]
        );

        res.redirect('/admin/stars-management?success=awarded');
    } catch (e) { 
        console.error(e);
        res.status(500).send("خطأ في قاعدة البيانات: " + e.message); 
    }
});


app.post('/admin/stars/reset-all', async (req, res) => {
    try {
        // 1. تصفير النقاط لجميع المعلمين
        await pool.query("UPDATE enseignants SET stars_count = 0");
        
        // 2. تسجيل عملية التصفير في السجل العام (اختياري)
        await pool.query("INSERT INTO stars_log (teacher_id, points, reason) VALUES (NULL, 0, 'إعادة ضبط شاملة للنجوم لبدء دورة جديدة')");
        
        console.log("🔄 تم تصفير جميع نجوم المعلمين بنجاح");
        res.redirect('/admin/stars-management');
    } catch (e) {
        console.error("خطأ في تصفير النجوم:", e.message);
        res.status(500).send("فشل في إعادة ضبط النجوم");
    }
});
app.get('/admin/enseignants/supprimer/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query("DELETE FROM enseignants WHERE id = $1", [id]);
        res.redirect('/admin/enseignants');
    } catch (e) {
        console.error(e);
        res.status(500).send("خطأ في حذف المعلم");
    }
});

app.get('/admin/eleves/supprimer/:id', async (req, res) => {
    try {
        const { id } = req.params;
        // الحذف من students
        await pool.query("DELETE FROM students WHERE id = $1", [id]);
        res.redirect('/admin/eleves?success=deleted');
    } catch (e) {
        res.redirect('/admin/eleves?error=delete_failed');
    }
});

//-------future features end here-------

// ==========================================
// قسم الإعدادات المتقدمة وأدوات المعلم (الموحد)
// ==========================================

// 1. مسار عرض صفحة أدوات المعلم
app.get('/admin/teacher-tools-management', isAdmin, async (req, res) => {
    try {
        // إنشاء الجدول إذا لم يكن موجوداً لضمان عدم تعطل الصفحة
        await pool.query(`CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value text)`);
        
        const result = await pool.query("SELECT * FROM settings");
        let tools = {};
        result.rows.forEach(row => {
            tools[row.key] = row.value;
        });

        res.render('teacher-tools-management', { 
            ecole: "ابن دريد", 
            tools: tools 
        });
    } catch (err) {
        console.error("Error loading tools:", err);
        res.render('teacher-tools-management', { ecole: "ابن دريد", tools: {} });
    }
});

// 2. مسار حفظ إعدادات الأدوات (POST)
app.post('/admin/update-teacher-tools', isAdmin, async (req, res) => {
    const { exam_table_active, polls_active, digital_library } = req.body;
    const settings = [
        { k: 'exam_table_active', v: exam_table_active === 'on' ? 'true' : 'false' },
        { k: 'polls_active', v: polls_active === 'on' ? 'true' : 'false' },
        { k: 'digital_library', v: digital_library === 'on' ? 'true' : 'false' }
    ];

    try {
        for (let item of settings) {
            await pool.query(`
                INSERT INTO settings (key, value) VALUES ($1, $2)
                ON CONFLICT (key) DO UPDATE SET value = $2`, [item.k, item.v]);
        }
        res.send("<script>alert('تم التحديث بنجاح'); window.location.href='/admin/teacher-tools-management';</script>");
    } catch (err) {
        console.error("Update error:", err);
        res.status(500).send("خطأ في حفظ الإعدادات");
    }
});

// 3. صفحة الإعدادات المتقدمة
app.get('/admin/advanced-settings', isAdmin, (req, res) => {
    res.render('advanced-settings', { 
        ecole: "ابن دريد" 
    });
});

// 4. مسار تنفيذ الحذف (Reset) - نسخة موحدة وآمنة
app.get('/admin/reset/:target', isAdmin, async (req, res) => {
    const target = req.params.target;
    
    // منع خطأ الـ undefined الذي ظهر لك في سجل الأخطاء
    if (!target || target === 'undefined') {
        return res.status(400).send("فشل: الهدف غير محدد بشكل صحيح");
    }

    let queries = [];
    try {
        if (target === 'eleves') {
            // ترتيب الحذف مهم جداً بسبب العلاقات (Foreign Keys)
            queries = [
                "DELETE FROM student_absences",
                "DELETE FROM academic_evaluations",
                "DELETE FROM behavior_logs",
                "DELETE FROM evaluation_requests",
                "DELETE FROM eleves"
            ];
        } else if (target === 'absences') {
            queries = [
                "DELETE FROM absences",
                "DELETE FROM student_absences"
            ];
        } else if (target === 'timetable') {
            queries = ["DELETE FROM timetable"];
        }

        if (queries.length > 0) {
            for (let q of queries) {
                await pool.query(q);
            }
            res.send("<script>alert('تم مسح البيانات بنجاح'); window.location.href='/admin/advanced-settings';</script>");
        } else {
            res.redirect('/admin/advanced-settings');
        }
    } catch (err) {
        console.error("Reset Execution Error:", err);
        res.status(500).send("حدث خطأ تقني أثناء الحذف: " + err.message);
    }
});

// time shemas -----------
// --- Route: جلب بيانات مخطط معين من قاعدة البيانات ---
app.get('/api/get-scheme/:id', async (req, res) => {
    const schemeId = req.params.id;
    try {
        // نستخدم pool هنا لأنك عرفتها في بداية الملف
        const result = await pool.query(
            "SELECT period_num, start_time, end_time FROM time_schemes WHERE scheme_id = $1 ORDER BY period_num", 
            [schemeId]
        );
        res.json(result.rows); 
    } catch (err) {
        console.error("خطأ في جلب المخطط:", err.message);
        res.status(500).json({ error: "خطأ في الاتصال بقاعدة البيانات" });
    }
});

// --- Route: حفظ المخطط الحالي إلى قاعدة البيانات ---
app.post('/api/save-scheme', async (req, res) => {
    const { schemeId, periods } = req.body;
    try {
        await pool.query("BEGIN"); // بدء Transaction
        
        // 1. حذف البيانات القديمة لهذا المخطط
        await pool.query("DELETE FROM time_schemes WHERE scheme_id = $1", [schemeId]);
        
        // 2. إدخال البيانات الجديدة
        for (const p of periods) {
            await pool.query(
                "INSERT INTO time_schemes (scheme_id, period_num, start_time, end_time) VALUES ($1, $2, $3, $4)",
                [schemeId, p.period_num, p.start, p.end]
            );
        }
        
        await pool.query("COMMIT");
        res.json({ success: true });
    } catch (err) {
        await pool.query("ROLLBACK");
        console.error("خطأ في حفظ المخطط:", err.message);
        res.status(500).json({ error: "فشل حفظ البيانات" });
    }
});
    // --- [ تشغيل الخادم ] ---
    app.listen(PORT, () => {
        console.log(`🚀 نظام مدرسة ابن دريد يعمل على: http://localhost:${PORT}`);
    });

});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});