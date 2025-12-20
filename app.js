const express = require('express');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');
const cookieParser = require('cookie-parser');

const app = express(); // تم نقل التعريف هنا لإصلاح خطأ ReferenceError

// إعدادات Middleware الأساسية
app.use(cookieParser());
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const ADMIN_PASSWORD = "admin123"; // كلمة مرور الأدمن

let db;

// 1. إعداد قاعدة البيانات والجداول
async function initializeDatabase() {
    db = await open({
        filename: './ecole_ibn_durid.db',
        driver: sqlite3.Database
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS enseignants (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            nom TEXT, matiere TEXT, phone_number TEXT, password TEXT DEFAULT '123456'
        );
        CREATE TABLE IF NOT EXISTS eleves (
            id INTEGER PRIMARY KEY AUTOINCREMENT, nom TEXT, classe TEXT, section TEXT
        );
        CREATE TABLE IF NOT EXISTS affectations (
            id INTEGER PRIMARY KEY AUTOINCREMENT, enseignant_id INTEGER, classe TEXT, section TEXT,
            FOREIGN KEY(enseignant_id) REFERENCES enseignants(id)
        );
        CREATE TABLE IF NOT EXISTS timetable (
            id INTEGER PRIMARY KEY AUTOINCREMENT, enseignant_id INTEGER, classe TEXT, section TEXT, jour TEXT, periode INTEGER, matiere TEXT,
            FOREIGN KEY(enseignant_id) REFERENCES enseignants(id)
        );
        CREATE TABLE IF NOT EXISTS absences (
            id INTEGER PRIMARY KEY AUTOINCREMENT, enseignant_id INTEGER, date TEXT, raison TEXT,
            FOREIGN KEY(enseignant_id) REFERENCES enseignants(id)
        );
        CREATE TABLE IF NOT EXISTS student_absences (
            id INTEGER PRIMARY KEY AUTOINCREMENT, eleve_id INTEGER, enseignant_id INTEGER, date TEXT, periode INTEGER
        );
        CREATE TABLE IF NOT EXISTS behavior_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER, teacher_id INTEGER, event TEXT, date TEXT
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY, value TEXT
        );
        CREATE TABLE IF NOT EXISTS school_periods (
            id INTEGER PRIMARY KEY, start_time TEXT, end_time TEXT
        );
        CREATE TABLE IF NOT EXISTS school_subjects (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE
        );
        CREATE TABLE IF NOT EXISTS school_classes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            class_name TEXT UNIQUE,
            num_sections INTEGER
        );
    `);
    
    console.log("✅ النظام متصل بقاعدة البيانات وجاهز.");
}

// وظيفه الحماية: تمنع أي شخص لا يملك الكوكيز من دخول صفحات الأدمن
function isAdmin(req, res, next) {
    if (req.cookies.admin_auth === 'authenticated') {
        next();
    } else {
        res.redirect('/admin/login');
    }
}

initializeDatabase().then(() => {

    // --- [ مسارات تسجيل الدخول للأدمن - يجب أن تكون قبل الحماية ] ---

    app.get('/admin/login', (req, res) => {
        res.render('admin_login', { error: null, titre: "دخول الإدارة" });
    });

    app.post('/admin/login', (req, res) => {
        if (req.body.password === ADMIN_PASSWORD) {
            res.cookie('admin_auth', 'authenticated', { httpOnly: true, maxAge: 3600000 });
            res.redirect('/admin/dashboard');
        } else {
            res.render('admin_login', { error: "كلمة المرور غير صحيحة", titre: "دخول الإدارة" });
        }
    });

    // تطبيق الحماية على جميع مسارات /admin القادمة
    app.use('/admin', isAdmin);

    // --- [ قسـم الأدمن المحمي - Admin Section ] ---

    app.get('/admin/dashboard', (req, res) => {
        res.render('admin_dashboard', { ecole: "مدرسة ابن دريد", titre: "لوحة التحكم" });
    });

    // إعدادات النظام
    app.get('/admin/settings', async (req, res) => {
        const classes = await db.all("SELECT * FROM school_classes");
        const periods = await db.all("SELECT * FROM school_periods ORDER BY id ASC");
        const subjects = await db.all("SELECT * FROM school_subjects");
        const teachers = await db.all("SELECT id, nom, password FROM enseignants");
        res.render('admin_settings', { 
            titre: "إعدادات النظام", 
            classes, periods, subjects, teachers
        });
    });

    app.post('/admin/settings/classes/add', async (req, res) => {
        const { class_name, num_sections } = req.body;
        await db.run("INSERT OR REPLACE INTO school_classes (class_name, num_sections) VALUES (?, ?)", [class_name, num_sections]);
        res.redirect('/admin/settings');
    });

    app.post('/admin/settings/classes/delete', async (req, res) => {
        await db.run("DELETE FROM school_classes WHERE id = ?", [req.body.class_id]);
        res.redirect('/admin/settings');
    });

    app.post('/admin/settings/subjects/add', async (req, res) => {
        await db.run("INSERT OR IGNORE INTO school_subjects (name) VALUES (?)", [req.body.subject_name]);
        res.redirect('/admin/settings');
    });

    app.post('/admin/settings/password/update', async (req, res) => {
        await db.run("UPDATE enseignants SET password = ? WHERE id = ?", [req.body.new_password, req.body.teacher_id]);
        res.redirect('/admin/settings');
    });

    // إدارة المعلمين
    app.get('/admin/enseignants', async (req, res) => {
        const enseignants = await db.all("SELECT * FROM enseignants");
        const affectations = await db.all(`SELECT a.id, e.nom, a.classe, a.section FROM affectations a JOIN enseignants e ON a.enseignant_id = e.id`);
        const subjects = await db.all("SELECT * FROM school_subjects");
        const classes = await db.all("SELECT * FROM school_classes");
        res.render('gestion_enseignants', { enseignants, affectations, subjects, classes, titre: "إدارة المعلمين" });
    });

    app.post('/admin/enseignants/ajouter', async (req, res) => {
        await db.run("INSERT INTO enseignants (nom, matiere, phone_number) VALUES (?, ?, ?)", [req.body.nom, req.body.matiere, req.body.phone]);
        res.redirect('/admin/enseignants');
    });

    app.post('/admin/enseignants/affecter', async (req, res) => {
        const { enseignant_id, class_info } = req.body;
        const [classe, section] = class_info.split('|');
        await db.run("INSERT INTO affectations (enseignant_id, classe, section) VALUES (?, ?, ?)", [enseignant_id, classe, section]);
        res.redirect('/admin/enseignants');
    });

    app.post('/admin/enseignants/desaffecter', async (req, res) => {
        await db.run("DELETE FROM affectations WHERE id = ?", [req.body.id]);
        res.redirect('/admin/enseignants');
    });

    // إدارة الطلاب 
    app.get('/admin/eleves', async (req, res) => {
        const eleves = await db.all("SELECT * FROM eleves ORDER BY classe, section");
        const classes = await db.all("SELECT * FROM school_classes");
        res.render('gestion_eleves', { eleves, classes, titre: "إدارة الطلاب" });
    });

    app.post('/admin/eleves/ajouter', async (req, res) => {
        const { nom, class_info } = req.body;
        const [classe, section] = class_info.split('|');
        await db.run("INSERT INTO eleves (nom, classe, section) VALUES (?, ?, ?)", [nom, classe, section]);
        res.redirect('/admin/eleves');
    });

    app.get('/admin/eleves/supprimer/:id', async (req, res) => {
        await db.run("DELETE FROM eleves WHERE id = ?", [req.params.id]);
        res.redirect('/admin/eleves');
    });

    // الجدول المدرسي
    app.get('/admin/timetable', async (req, res) => {
        const teacher_filter = req.query.teacher_filter || ""; 
        const class_filter = req.query.class_filter || ""; 
        try {
            const enseignants = await db.all("SELECT * FROM enseignants");
            const classes = await db.all("SELECT * FROM school_classes");
            const all_affectations = await db.all("SELECT * FROM affectations");
            const unique_classes = await db.all("SELECT DISTINCT classe, section FROM timetable ORDER BY classe, section");

            let query = `SELECT t.*, e.nom as prof_nom FROM timetable t JOIN enseignants e ON t.enseignant_id = e.id WHERE 1=1`;
            let params = [];
            
            if (teacher_filter) { query += ` AND t.enseignant_id = ?`; params.push(teacher_filter); }
            if (class_filter) {
                const [c, s] = class_filter.split('-'); 
                query += ` AND t.classe = ? AND t.section = ?`; params.push(c, s);
            }

            const schedule = await db.all(query, params);
            res.render('gestion_timetable', { enseignants, schedule, classes, teacher_filter, class_filter, unique_classes, all_affectations, titre: "الجدول المدرسي" });
        } catch (error) { res.status(500).send("خطأ في تحميل البيانات"); }
    });

    app.post('/admin/timetable/ajouter', async (req, res) => {
        const [classe, section] = req.body.class_info.split('|');
        const prof = await db.get("SELECT matiere FROM enseignants WHERE id = ?", [req.body.enseignant_id]);
        await db.run("INSERT INTO timetable (enseignant_id, classe, section, jour, periode, matiere) VALUES (?, ?, ?, ?, ?, ?)",
            [req.body.enseignant_id, classe, section, req.body.jour, req.body.periode, prof.matiere]);
        res.redirect('/admin/timetable');
    });

    // غياب المعلمين
    app.get('/admin/absence-profs', async (req, res) => {
        const today = new Date().toISOString().split('T')[0];
        const enseignants = await db.all("SELECT * FROM enseignants");
        const ghaibeen = await db.all(`SELECT a.*, e.nom, e.matiere FROM absences a JOIN enseignants e ON a.enseignant_id = e.id WHERE a.date = ?`, [today]);
        res.render('gestion_absences', { enseignants, ghaibeen, today, titre: "غياب المعلمين" });
    });

    app.post('/admin/absences/ajouter', async (req, res) => {
        const today = new Date().toISOString().split('T')[0];
        await db.run("INSERT INTO absences (enseignant_id, date, raison) VALUES (?, ?, ?)", [req.body.enseignant_id, today, req.body.raison]);
        res.redirect('/admin/absence-profs');
    });

    // البدلاء وكشف الاحتياط
    app.get('/admin/absences/suggestions/:teacher_id', async (req, res) => {
        const teacher_id = req.params.teacher_id;
        const days = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
        const todayName = days[new Date().getDay()];
        try {
            const absentSessions = await db.all("SELECT periode FROM timetable WHERE enseignant_id = ? AND jour = ?", [teacher_id, todayName]);
            const periodes = absentSessions.map(s => s.periode);
            if (periodes.length === 0) return res.json({ suggestions: [], absent_periods: [] });
            const placeholders = periodes.map(() => '?').join(',');
            const suggestions = await db.all(`SELECT id, nom, matiere FROM enseignants WHERE id != ? AND id NOT IN (SELECT enseignant_id FROM timetable WHERE jour = ? AND periode IN (${placeholders}))`, [teacher_id, todayName, ...periodes]);
            res.json({ suggestions, absent_periods: periodes });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/admin/absences/print-reserve/:teacher_id', async (req, res) => {
        const teacher_id = req.params.teacher_id;
        const days = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
        const today_name = days[new Date().getDay()];
        try {
            const sessions = await db.all("SELECT periode as hessa, classe, section FROM timetable WHERE enseignant_id = ? AND jour = ?", [teacher_id, today_name]);
            const suggestions = [];
            for (let session of sessions) {
                const available_profs = await db.all(`SELECT nom, matiere FROM enseignants WHERE id != ? AND id NOT IN (SELECT enseignant_id FROM timetable WHERE jour = ? AND periode = ?)`, [teacher_id, today_name, session.hessa]);
                suggestions.push({ hessa: session.hessa, classe: session.classe, section: session.section, available_profs });
            }
            res.render('print_reserve', { suggestions, today_name, titre: "كشف توزيع الاحتياط" });
        } catch (e) { res.status(500).send("خطأ"); }
    });

   app.get('/admin/rapport-absences-eleves', async (req, res) => {
    try {
        const view = req.query.view || ''; // جلب نوع العرض من الرابط
        let query = `
            SELECT sa.date, el.nom as student_name, el.classe, el.section, sa.periode, en.nom as teacher_name 
            FROM student_absences sa 
            JOIN eleves el ON sa.eleve_id = el.id 
            JOIN enseignants en ON sa.enseignant_id = en.id`;
        
        let params = [];

        // إضافة منطق الفلترة بناءً على الـ view
        if (view === 'daily') {
            query += " WHERE sa.date = date('now', 'localtime')";
        } else if (view === 'weekly') {
            query += " WHERE sa.date >= date('now', '-7 days')";
        } else if (view === 'monthly') {
            query += " WHERE sa.date >= date('now', 'start of month')";
        }

        query += " ORDER BY sa.date DESC";

        const stats = await db.all(query, params);
        
        // إرسال المتغيرات للملف، تأكد من إرسال view هنا
        res.render('admin_student_reports', { 
            stats, 
            view, 
            titre: "تقارير غياب الطلاب" 
        });
    } catch (error) {
        console.error(error);
        res.status(500).send("خطأ في جلب تقارير الغياب");
    }
});

    // --- [ قسـم المعلـم - غير محمي بـ isAdmin ] ---

    app.get('/teacher/login', async (req, res) => {
        const enseignants = await db.all("SELECT id, nom FROM enseignants");
        res.render('teacher_login', { enseignants, error: null, titre: "دخول المعلمين" });
    });

    app.post('/teacher/login', async (req, res) => {
        const user = await db.get("SELECT * FROM enseignants WHERE id = ? AND password = ?", [req.body.teacher_id, req.body.password]);
        if (user) res.redirect(`/teacher/dashboard/${user.id}`);
        else {
            const enseignants = await db.all("SELECT id, nom FROM enseignants");
            res.render('teacher_login', { enseignants, error: "كلمة المرور غير صحيحة", titre: "دخول المعلمين" });
        }
    });

    app.get('/teacher/dashboard/:id', async (req, res) => {
        const teacher_id = req.params.id;
        const todayDate = new Date().toISOString().split('T')[0];
        const days = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
        const todayName = days[new Date().getDay()];
        const prof = await db.get("SELECT * FROM enseignants WHERE id = ?", [teacher_id]);
        if (!prof) return res.redirect('/teacher/login');

        const sessions = await db.all("SELECT DISTINCT classe, section, periode FROM timetable WHERE enseignant_id = ? AND jour = ?", [teacher_id, todayName]);
        const students = await db.all(`SELECT * FROM eleves WHERE (classe, section) IN (SELECT DISTINCT classe, section FROM timetable WHERE enseignant_id = ? AND jour = ?) ORDER BY nom ASC`, [teacher_id, todayName]);
        const replacements = await db.all(`SELECT e.nom, e.matiere, a.raison FROM absences a JOIN enseignants e ON a.enseignant_id = e.id WHERE a.date = ?`, [todayDate]);

        res.render('teacher_dashboard', { prof, students, sessions, replacements, today: todayDate, titre: "لوحة المعلم", success: req.query.success || false, behavior_success: req.query.behavior_success || false });
    });

    app.post('/teacher/absences/mark', async (req, res) => {
        if (req.body.student_ids) {
            const ids = Array.isArray(req.body.student_ids) ? req.body.student_ids : [req.body.student_ids];
            for (let s_id of ids) { await db.run("INSERT INTO student_absences (eleve_id, enseignant_id, date, periode) VALUES (?, ?, ?, ?)", [s_id, req.body.teacher_id, req.body.date, req.body.periode]); }
        }
        res.redirect(`/teacher/dashboard/${req.body.teacher_id}?success=true`);
    });

    app.post('/teacher/behavior/add', async (req, res) => {
        await db.run("INSERT INTO behavior_logs (student_id, teacher_id, event, date) VALUES (?, ?, ?, ?)", [req.body.student_id, req.body.teacher_id, req.body.event_desc, new Date().toISOString().split('T')[0]]);
        res.redirect(`/teacher/dashboard/${req.body.teacher_id}?behavior_success=true`);
    });

    app.get('/logout', (req, res) => {
        res.clearCookie('admin_auth'); // تسجيل الخروج للأدمن
        res.redirect('/teacher/login');
    });

    // مسار عرض تقارير السلوك للأدمن
// مسار عرض تقارير السلوك للأدمن - النسخة المصححة المتوافقة مع جداولك
    app.get('/admin/behavior-reports', async (req, res) => {
        try {
            // ملاحظة: تم تعديل الاستعلام ليتوافق مع أسماء الجداول في كودك (behavior_logs, eleves, enseignants)
            const reports = await db.all(`
                SELECT 
                    s.nom AS student_name, 
                    s.classe, 
                    s.section, 
                    b.event AS event_desc, 
                    b.date, 
                    e.nom AS teacher_name
                FROM behavior_logs b
                JOIN eleves s ON b.student_id = s.id
                JOIN enseignants e ON b.teacher_id = e.id
                ORDER BY b.date DESC
            `);
            
            res.render('admin_behavior', { 
                reports, 
                titre: "تقارير السلوك",
                ecole: "مدرسة ابن دريد" 
            });
        } catch (err) {
            console.error(err);
            res.status(500).send("خطأ في جلب التقارير: تأكد من وجود جدول behavior_logs وبيانات صحيحة.");
        }
    });

    app.listen(3000, () => console.log(`🚀 النظام يعمل: http://localhost:3000/admin/dashboard`));
});