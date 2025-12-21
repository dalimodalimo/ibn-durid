const express = require('express');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');
const cookieParser = require('cookie-parser');

/**
 * إعدادات التطبيق الأساسية
 */
const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = "admin123"; 

app.use(cookieParser());
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json()); 
app.use(express.static(path.join(__dirname, 'public')));

let db;

/**
 * نظام تهيئة قاعدة البيانات
 */
async function initializeDatabase() {
    try {
        db = await open({
            filename: path.resolve(__dirname, 'ecole_ibn_durid.db'),
            driver: sqlite3.Database
        });

        await db.exec("PRAGMA journal_mode = WAL;");
        await db.exec("PRAGMA synchronous = NORMAL;");
        
        await db.exec(`
            CREATE TABLE IF NOT EXISTS announcements (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                date TEXT NOT NULL,
                priority TEXT DEFAULT 'normal'
            );

            CREATE TABLE IF NOT EXISTS enseignants (
                id INTEGER PRIMARY KEY AUTOINCREMENT, 
                nom TEXT NOT NULL, 
                matiere TEXT, 
                phone_number TEXT, 
                password TEXT DEFAULT '123456',
                rank TEXT DEFAULT 'معلم',
                is_admin_duty INTEGER DEFAULT 0,
                weekly_load INTEGER DEFAULT 0,
                last_login TEXT
            );

            CREATE TABLE IF NOT EXISTS school_classes (
                id INTEGER PRIMARY KEY AUTOINCREMENT, 
                class_name TEXT UNIQUE, 
                num_sections INTEGER
            );

            CREATE TABLE IF NOT EXISTS affectations (
                id INTEGER PRIMARY KEY AUTOINCREMENT, 
                enseignant_id INTEGER, 
                classe TEXT, 
                section TEXT,
                FOREIGN KEY(enseignant_id) REFERENCES enseignants(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS timetable (
                id INTEGER PRIMARY KEY AUTOINCREMENT, 
                enseignant_id INTEGER, 
                classe TEXT, 
                section TEXT, 
                jour TEXT, 
                periode INTEGER, 
                matiere TEXT,
                FOREIGN KEY(enseignant_id) REFERENCES enseignants(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS absences (
                id INTEGER PRIMARY KEY AUTOINCREMENT, 
                enseignant_id INTEGER, 
                date TEXT, 
                raison TEXT,
                status TEXT DEFAULT 'pending',
                FOREIGN KEY(enseignant_id) REFERENCES enseignants(id)
            );

            CREATE TABLE IF NOT EXISTS substitute_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                substitute_id INTEGER,
                absent_id INTEGER,
                date TEXT,
                periode INTEGER,
                classe TEXT,
                section TEXT,
                FOREIGN KEY(substitute_id) REFERENCES enseignants(id),
                FOREIGN KEY(absent_id) REFERENCES enseignants(id)
            );

            CREATE TABLE IF NOT EXISTS eleves (
                id INTEGER PRIMARY KEY AUTOINCREMENT, 
                nom TEXT NOT NULL, 
                classe TEXT, 
                section TEXT,
                parent_phone TEXT
            );

            CREATE TABLE IF NOT EXISTS student_absences (
                id INTEGER PRIMARY KEY AUTOINCREMENT, 
                eleve_id INTEGER, 
                enseignant_id INTEGER, 
                date TEXT, 
                periode INTEGER,
                justified INTEGER DEFAULT 0,
                FOREIGN KEY(eleve_id) REFERENCES eleves(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS behavior_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT, 
                student_id INTEGER, 
                teacher_id INTEGER, 
                event TEXT, 
                date TEXT,
                severity TEXT DEFAULT 'low',
                FOREIGN KEY(student_id) REFERENCES eleves(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS school_subjects (
                id INTEGER PRIMARY KEY AUTOINCREMENT, 
                name TEXT UNIQUE
            );

            CREATE TABLE IF NOT EXISTS school_periods (
                id INTEGER PRIMARY KEY AUTOINCREMENT, 
                start_time TEXT, 
                end_time TEXT
            );
        `);

       const columnsToAdd = [
    { table: 'substitute_logs', col: 'absent_id', type: 'INTEGER' },
    { table: 'substitute_logs', col: 'substitute_id', type: 'INTEGER' },
    { table: 'substitute_logs', col: 'periode', type: 'INTEGER' },
    { table: 'substitute_logs', col: 'classe', type: 'TEXT' },
    { table: 'substitute_logs', col: 'section', type: 'TEXT' },
    { table: 'substitute_logs', col: 'status', type: "TEXT DEFAULT 'pending'" }, // جديد: حالة الطلب
    { table: 'substitute_logs', col: 'reject_reason', type: "TEXT" },           // جديد: سبب الرفض
    { table: 'enseignants', col: 'last_login', type: 'TEXT' },
    { table: 'absences', col: 'status', type: "TEXT DEFAULT 'pending'" }
];

        for (const item of columnsToAdd) {
            try {
                await db.exec(`ALTER TABLE ${item.table} ADD COLUMN ${item.col} ${item.type};`);
            } catch (e) {}
        }

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
    // إذا كان المسار هو صفحة اللوجن، اسمح بالمرور دون فحص الكوكيز
    if (req.path === '/login') { 
        return next();
    }
    
    if (req.cookies.admin_auth === 'authenticated') {
        return next();
    }
    
    res.redirect('/admin/login');
}

/**
 * تشغيل الخادم
 */
initializeDatabase().then(() => {

    // --- [ 1. بوابات الدخول (يجب أن تسبق الـ Middleware) ] ---

    app.get('/', (req, res) => res.redirect('/teacher/login'));

    app.get('/admin/login', (req, res) => {
        res.render('admin_login', { error: null, titre: "دخول الإدارة" });
    });

   app.post('/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        res.cookie('admin_auth', 'authenticated', { httpOnly: true });
        return res.redirect('/admin/dashboard'); // الـ return هنا جوهرية
    } else {
        return res.render('admin_login', { error: "خطأ", titre: "دخول" });
    }
});

    // --- [ 2. تطبيق حماية الإدارة بعد استثناء صفحات اللوجن ] ---
    app.use('/admin', isAdmin);

    // --- [ 3. لوحة تحكم المدير ] ---

    app.get('/admin/dashboard', async (req, res) => {
        try {
            const stats = {
                teachers: (await db.get("SELECT COUNT(*) as c FROM enseignants")).c,
                students: (await db.get("SELECT COUNT(*) as c FROM eleves")).c,
                absences: (await db.get("SELECT COUNT(*) as c FROM absences WHERE date = date('now')")).c
            };
            res.render('admin_dashboard', { 
                ecole: "مدرسة ابن دريد", 
                titre: "لوحة التحكم", 
                stats 
            });
        } catch (e) {
            res.status(500).send("خطأ في جلب إحصائيات اللوحة");
        }
    });

    // --- [ 4. إدارة المعلمين والتعيينات ] ---

    app.get('/admin/enseignants', async (req, res) => {
        try {
            const enseignants = await db.all("SELECT * FROM enseignants ORDER BY nom ASC");
            const affectations = await db.all("SELECT a.*, e.nom FROM affectations a JOIN enseignants e ON a.enseignant_id = e.id");
            const subjects = await db.all("SELECT * FROM school_subjects");
            const classes = await db.all("SELECT * FROM school_classes");
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
            await db.run("INSERT INTO enseignants (nom, matiere, phone_number) VALUES (?, ?, ?)", [nom, matiere, phone]);
            res.redirect('/admin/enseignants');
        } catch (e) {
            res.status(500).send("خطأ أثناء إضافة معلم جديد");
        }
    });

    app.post('/admin/enseignants/affecter-multiple', async (req, res) => {
        const { enseignant_id, classes_data } = req.body;
        try {
            const selectedClasses = JSON.parse(classes_data);
            for (const item of selectedClasses) {
                const [classe, section] = item.split('|');
                const exists = await db.get("SELECT id FROM affectations WHERE enseignant_id = ? AND classe = ? AND section = ?", [enseignant_id, classe, section]);
                if (!exists) {
                    await db.run("INSERT INTO affectations (enseignant_id, classe, section) VALUES (?, ?, ?)", [enseignant_id, classe, section]);
                }
            }
            res.redirect('/admin/enseignants');
        } catch (e) {
            res.status(500).send("خطأ في تعيين الأقسام");
        }
    });

    app.get('/admin/enseignants/supprimer/:id', async (req, res) => {
        try {
            await db.run("DELETE FROM enseignants WHERE id = ?", [req.params.id]);
            res.redirect('/admin/enseignants');
        } catch (e) {
            res.status(500).send("فشل حذف المعلم");
        }
    });

    // --- [ 5. إدارة الجدول الزمني ] ---

    app.get('/admin/timetable', async (req, res) => {
        try {
            const t_filter = req.query.teacher_filter || ""; 
            const c_filter = req.query.class_filter || ""; 
            const enseignants = await db.all("SELECT * FROM enseignants ORDER BY nom");
            const classes = await db.all("SELECT * FROM school_classes");
            const all_affectations = await db.all("SELECT * FROM affectations"); 
            const unique_classes = await db.all("SELECT DISTINCT classe, section FROM timetable ORDER BY classe, section");
            
            let query = `SELECT t.*, e.nom as prof_nom FROM timetable t JOIN enseignants e ON t.enseignant_id = e.id WHERE 1=1`;
            let params = [];
            
            if (t_filter) { 
                query += ` AND t.enseignant_id = ?`; 
                params.push(t_filter); 
            }
            if (c_filter) {
                const parts = c_filter.split('-');
                if(parts.length === 2) {
                    query += ` AND t.classe = ? AND t.section = ?`;
                    params.push(parts[0], parts[1]);
                }
            }
            
            const schedule = await db.all(query, params);
            res.render('gestion_timetable', { 
                enseignants, schedule, classes, all_affectations, 
                teacher_filter: t_filter, class_filter: c_filter, unique_classes, titre: "الجدول المدرسي" 
            });
        } catch (e) {
            res.status(500).send("خطأ في تحميل الجدول");
        }
    });

    app.post('/admin/timetable/ajouter', async (req, res) => {
        try {
            const { enseignant_id, class_info, jour, periode } = req.body;
            const [classe, section] = class_info.split('|');
            const prof = await db.get("SELECT matiere FROM enseignants WHERE id = ?", [enseignant_id]);
            
            const conflict = await db.get("SELECT id FROM timetable WHERE enseignant_id = ? AND jour = ? AND periode = ?", [enseignant_id, jour, periode]);
            if (conflict) return res.status(400).send("هذا المعلم لديه حصة بالفعل في هذا الوقت");

            await db.run("INSERT INTO timetable (enseignant_id, classe, section, jour, periode, matiere) VALUES (?, ?, ?, ?, ?, ?)",
                [enseignant_id, classe, section, jour, periode, prof.matiere]);
            res.redirect('/admin/timetable');
        } catch (e) {
            res.status(500).send("خطأ في إضافة حصة");
        }
    });

    // --- [ 6. إدارة غياب المعلمين والاحتياط ] ---

   // --- [ 6. إدارة غياب المعلمين والاحتياط ] ---

    app.get('/admin/absence-profs', async (req, res) => {
        try {
            const today = new Date().toISOString().split('T')[0];
            const days = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
            const todayName = days[new Date().getDay()];

            // 1. جلب قائمة كل المعلمين لعرضهم في قائمة الاختيار
            const enseignants = await db.all("SELECT * FROM enseignants ORDER BY nom ASC") || [];

            // 2. جلب الغائبين الذين لديهم حصص اليوم ولم يتم تعويضهم بعد
           // جلب الغائبين الذين لديهم حصص اليوم ولم يتم تغطيتها بحصة "مقبولة"
const ghaibeen = await db.all(`
    SELECT DISTINCT 
        e.id as teacher_id, 
        e.nom, 
        e.matiere, 
        t.periode, 
        t.classe, 
        t.section
    FROM absences a
    JOIN enseignants e ON a.enseignant_id = e.id
    JOIN timetable t ON e.id = t.enseignant_id
    WHERE a.date = ? 
    AND (t.jour = ? OR t.jour = REPLACE(?, 'إ', 'ا')) -- يحل مشكلة الإثنين/الاثنين
    AND NOT EXISTS (
        SELECT 1 FROM substitute_logs sl 
        WHERE sl.absent_id = e.id 
        AND sl.date = a.date 
        AND sl.periode = t.periode
        AND sl.classe = t.classe
        AND sl.section = t.section
        AND sl.status IN ('accepted', 'pending') -- يختفي فقط إذا قُبل أو قيد الانتظار
    )
    ORDER BY t.periode ASC
`, [today, todayName, todayName]) || [];
            // 3. جلب اقتراحات المعلمين المتاحين للاحتياط
            let suggestions = await db.all(`
                SELECT e.*, 
                (SELECT COUNT(*) FROM substitute_logs WHERE substitute_id = e.id AND strftime('%m', date) = strftime('%m', 'now')) as reserve_this_month
                FROM enseignants e 
                WHERE e.id NOT IN (SELECT enseignant_id FROM absences WHERE date = ?)
                ORDER BY reserve_this_month ASC, weekly_load ASC
            `, [today]) || [];

            // 4. جلب سجل الاحتياط لهذا اليوم
            // 4. جلب سجل الاحتياط لهذا اليوم (الحصص التي تم تغطيتها)
const recapSubstitutions = await db.all(`
    SELECT 
        sl.id, 
        sl.date, 
        sl.periode, 
        sl.classe, 
        sl.section,
        sub.nom as substitute_name, 
        abs_p.nom as absent_name 
    FROM substitute_logs sl
    LEFT JOIN enseignants sub ON sl.substitute_id = sub.id
    LEFT JOIN enseignants abs_p ON sl.absent_id = abs_p.id
    WHERE sl.date = ?
    ORDER BY sl.periode ASC
`, [today]) || [];

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

    // المسار المفقود الذي تسبب في الخطأ (استقبال بيانات غياب المعلم)
    app.post('/admin/absences/ajouter', async (req, res) => {
        try {
            const { enseignant_id, date, raison } = req.body;
            
            // التحقق إذا كان الغياب مسجلاً مسبقاً لنفس المعلم في نفس اليوم
            const existing = await db.get("SELECT id FROM absences WHERE enseignant_id = ? AND date = ?", [enseignant_id, date]);
            
            if (!existing) {
                await db.run("INSERT INTO absences (enseignant_id, date, raison, status) VALUES (?, ?, ?, 'confirmed')", 
                    [enseignant_id, date, raison]);
            }
            
            res.redirect('/admin/absence-profs?success=absence_added');
        } catch (e) {
            console.error("Error adding absence:", e);
            res.status(500).send("فشل تسجيل الغياب");
        }
    });

    app.post('/admin/substitute/assign-session', async (req, res) => {
    try {
        let { substitute_id, absent_id, periode, classe, section } = req.body;
        const today = new Date().toISOString().split('T')[0];

        // --- منطق التوزيع التلقائي الذكي ---
        if (!substitute_id || substitute_id === "") {
            // البحث عن أفضل معلم متاح (ليس غائباً، وليس لديه حصة في نفس الفترة، ولديه أقل عدد احتياط هذا الشهر)
            const bestSubstitute = await db.get(`
                SELECT e.id 
                FROM enseignants e 
                WHERE e.id NOT IN (SELECT enseignant_id FROM absences WHERE date = ?) -- ليس غائباً
                AND e.id != ? -- ليس المعلم الغائب نفسه
                AND e.id NOT IN (SELECT enseignant_id FROM timetable WHERE jour = (
                    SELECT CASE strftime('%w', ?) 
                        WHEN '0' THEN 'الأحد' WHEN '1' THEN 'الإثنين' WHEN '2' THEN 'الثلاثاء' 
                        WHEN '3' THEN 'الأربعاء' WHEN '4' THEN 'الخميس' ELSE '' END
                ) AND periode = ?) -- ليس لديه حصة رسمية الآن
                ORDER BY 
                    (SELECT COUNT(*) FROM substitute_logs WHERE substitute_id = e.id AND strftime('%m', date) = strftime('%m', 'now')) ASC, 
                    e.weekly_load ASC 
                LIMIT 1
            `, [today, absent_id, today, periode]);

            if (bestSubstitute) {
                substitute_id = bestSubstitute.id;
            } else {
                return res.status(400).send("نعتذر، لا يوجد معلم متاح للاحتياط في هذه الحصة حالياً.");
            }
        }

        // إدخال البيانات في الجدول (سواء كان الاختيار يدوي أو تلقائي)
        // قم بتغيير سطر الـ INSERT ليكون هكذا:
await db.run(`INSERT INTO substitute_logs (substitute_id, absent_id, date, periode, classe, section, status) 
              VALUES (?, ?, ?, ?, ?, ?, 'pending')`, // وضعنا 'pending' كحالة افتراضية
    [substitute_id, absent_id, today, periode, classe, section]);

        res.redirect('/admin/absence-profs?success=assigned');
    } catch (e) {
        console.error("خطأ في تعيين الاحتياط:", e);
        res.status(500).send("فشل تعيين البديل: " + e.message);
    }
});

    // مسار إلغاء حصة احتياط وإعادتها لقائمة الاحتياج


    // --- [ 7. إدارة الطلاب ] ---

    app.get('/admin/eleves', async (req, res) => {
        try {
            const eleves = await db.all("SELECT * FROM eleves ORDER BY classe, section, nom");
            const classes = await db.all("SELECT * FROM school_classes");
            res.render('gestion_eleves', { eleves, classes, titre: "إدارة سجلات الطلاب" });
        } catch (e) {
            res.status(500).send("خطأ في تحميل سجل الطلاب");
        }
    });

    app.post('/admin/eleves/ajouter', async (req, res) => {
        try {
            const { nom, class_info, parent_phone } = req.body;
            const [classe, section] = class_info.split('|');
            await db.run("INSERT INTO eleves (nom, classe, section, parent_phone) VALUES (?, ?, ?, ?)", 
                [nom, classe, section, parent_phone]);
            res.redirect('/admin/eleves');
        } catch (e) {
            res.status(500).send("خطأ في حفظ الطالب");
        }
    });

    // --- [ 8. التقارير الإدارية ] ---

    app.get('/admin/rapport-absences-eleves', async (req, res) => {
        try {
            const absences = await db.all(`
                SELECT sa.*, e.nom as student_name, e.classe, e.section, t.nom as teacher_name
                FROM student_absences sa
                JOIN eleves e ON sa.eleve_id = e.id
                JOIN enseignants t ON sa.enseignant_id = t.id
                ORDER BY sa.date DESC, sa.periode ASC
            `);
            res.render('rapport_absences_eleves', { absences, titre: "تقرير غياب الطلاب" });
        } catch (e) {
            res.status(500).send("خطأ في تحميل تقرير الغياب");
        }
    });

    app.get('/admin/behavior-reports', async (req, res) => {
        try {
            const reports = await db.all(`
                SELECT bl.*, e.nom as student_name, e.classe, e.section, prof.nom as teacher_name
                FROM behavior_logs bl
                JOIN eleves e ON bl.student_id = e.id
                JOIN enseignants prof ON bl.teacher_id = prof.id
                ORDER BY bl.date DESC
            `);
            res.render('admin_behaviors', { reports, titre: "سجل الانضباط والسلوك" });
        } catch (e) {
            res.status(500).send("خطأ في تحميل سجل السلوك");
        }
    });

    // --- [ 9. إعدادات النظام ] ---

    app.get('/admin/settings', async (req, res) => {
        try {
            await db.run("UPDATE enseignants SET weekly_load = 0"); 
            const loads = await db.all("SELECT enseignant_id, COUNT(*) as count FROM timetable GROUP BY enseignant_id");
            for (let load of loads) {
                await db.run("UPDATE enseignants SET weekly_load = ? WHERE id = ?", [load.count, load.enseignant_id]);
            }

            const teachers = await db.all(`
                SELECT e.*, 
                (SELECT COUNT(*) FROM substitute_logs WHERE substitute_id = e.id AND strftime('%m', date) = strftime('%m', 'now')) as monthly_reserve 
                FROM enseignants e
            `);
            
            res.render('admin_settings', { 
                titre: "إعدادات النظام", 
                teachers, 
                classes: await db.all("SELECT * FROM school_classes"), 
                periods: await db.all("SELECT * FROM school_periods"), 
                subjects: await db.all("SELECT * FROM school_subjects") 
            });
        } catch (e) {
            res.status(500).send("خطأ في تحميل الإعدادات");
        }
    });

    // --- في قسم إدارة الإعلانات (داخل منطقة حماية admin) ---
app.post('/admin/announcements/add', async (req, res) => {
    try {
        const { title, content } = req.body;
        // استخدام تنسيق تاريخ مقروء بدلاً من ISO فقط ليظهر بشكل جميل للمعلم
        const today = new Date().toLocaleDateString('ar-EG', {
            year: 'numeric', month: 'long', day: 'numeric'
        });
        
        await db.run("INSERT INTO announcements (title, content, date) VALUES (?, ?, ?)", 
            [title, content, today]);
            
        res.redirect('/admin/dashboard?success=announcement_sent');
    } catch (e) {
        console.error("Error adding announcement:", e);
        res.status(500).send("خطأ في نشر الإعلان");
    }
} );

    // --- [ 10. منطقة المعلم (خارج حماية admin) ] ---

    app.get('/teacher/login', async (req, res) => {
        try {
            const enseignants = await db.all("SELECT id, nom FROM enseignants ORDER BY nom");
            res.render('teacher_login', { enseignants, error: null, titre: "دخول المعلمين" });
        } catch (e) {
            res.status(500).send("خطأ في تحميل صفحة الدخول");
        }
    });

   app.post('/teacher/login', async (req, res) => {
        const { teacher_id, password } = req.body;
        try {
            // التصحيح: تحويل teacher_id إلى Number
            const user = await db.get("SELECT * FROM enseignants WHERE id = ? AND password = ?", [Number(teacher_id), password]);
            if (user) {
                await db.run("UPDATE enseignants SET last_login = datetime('now') WHERE id = ?", [user.id]);
                return res.redirect(`/teacher/dashboard/${user.id}`);
            } else {
                const enseignants = await db.all("SELECT id, nom FROM enseignants ORDER BY nom");
                return res.render('teacher_login', { enseignants, error: "بيانات الدخول غير صحيحة", titre: "دخول المعلمين" });
            }
        } catch (e) {
            console.error(e);
            res.status(500).send("فشل تسجيل الدخول");
        }
    });

app.get('/teacher/dashboard/:id', async (req, res) => {
    try {
        const teacher_id = req.params.id;
        const prof = await db.get("SELECT * FROM enseignants WHERE id = ?", [teacher_id]);
        
        if (!prof) return res.redirect('/teacher/login');

        const now = new Date();
const days = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
let todayName = days[now.getDay()];

// فحص يدوي: إذا كانت قاعدة البيانات تستخدم "الاثنين" بدون همزة، فقم بإزالتها برمجياً
// أو الأفضل: اجعل الاستعلام يبحث عن الكلمتين
        const todayDate = now.toISOString().split('T')[0];

        // 1. جلب البيانات الأساسية (أوقات، إعلانات، طلاب)
        const periods = await db.all("SELECT * FROM school_periods ORDER BY id ASC") || [];
        const announcements = await db.all("SELECT * FROM announcements ORDER BY id DESC LIMIT 5") || [];
        const students = await db.all("SELECT * FROM eleves") || [];

        // 2. جلب الحصص العادية
        const sessions = await db.all(`
            SELECT t.*, 
            (SELECT COUNT(*) FROM student_absences 
             WHERE date = ? AND periode = t.periode 
             AND EXISTS (
                 SELECT 1 FROM eleves e 
                 WHERE e.id = student_absences.eleve_id 
                 AND e.classe = t.classe 
                 AND e.section = t.section
             )
            ) > 0 as is_marked
            FROM timetable t 
            WHERE t.enseignant_id = ? AND t.jour = ?
        `, [todayDate, teacher_id, todayName]) || [];

        // 3. جلب حصص الاحتياط
        const substitutions = await db.all(`
            SELECT sl.*, e_abs.nom as absent_name,
            (SELECT COUNT(*) FROM student_absences 
             WHERE date = sl.date AND periode = sl.periode 
             AND EXISTS (
                 SELECT 1 FROM eleves e 
                 WHERE e.id = student_absences.eleve_id 
                 AND e.classe = sl.classe 
                 AND e.section = sl.section
             )
            ) > 0 as is_marked
            FROM substitute_logs sl 
            JOIN enseignants e_abs ON sl.absent_id = e_abs.id
            WHERE sl.substitute_id = ? AND sl.date = ?
        `, [teacher_id, todayDate]) || [];

        // 4. معالجة بيانات الاحتياط (Mapping) - يجب أن يكون هنا قبل الاستخدام
        const mappedSubs = substitutions.map(s => ({
            id: s.id,
            periode: s.periode, 
            classe: s.classe, 
            section: s.section, 
            matiere: "إحتياط", 
            isSubstitute: true, 
            status: s.status || 'pending', 
            absent_name: s.absent_name,
            is_marked: s.is_marked 
        }));

        // 5. تصفية الحصص (المقبولة للجدول، والمعلقة للتنبيهات)
        const activeSessions = [
            ...sessions, 
            ...mappedSubs.filter(s => s.status === 'accepted')
        ];

        const pendingRequests = mappedSubs.filter(s => s.status === 'pending');

        // 6. إرسال كل البيانات للوحة التحكم مرة واحدة
        res.render('teacher_dashboard', { 
            prof, 
            sessions: activeSessions, // تذهب للجدول ولرصد الغياب
            pendingRequests,          // تذهب لصندوق التنبيهات العلوي
            periods, 
            students, 
            today: todayDate, 
            todayName, 
            announcements, 
            success: req.query.success, 
            titre: "لوحة المعلم" 
        });

    } catch (e) { 
        console.error("Dashboard Error:", e);
        res.status(500).send("Erreur: " + e.message); 
    }
});

    app.post('/teacher/absences/mark', async (req, res) => {
        const { teacher_id, date, periode, student_ids } = req.body;
        try {
            await db.run("DELETE FROM student_absences WHERE enseignant_id = ? AND date = ? AND periode = ?", [teacher_id, date, periode]);
            if (student_ids) {
                const ids = Array.isArray(student_ids) ? student_ids : [student_ids];
                const stmt = await db.prepare("INSERT INTO student_absences (eleve_id, enseignant_id, date, periode) VALUES (?, ?, ?, ?)");
                for (let id of ids) {
                    await stmt.run(id, teacher_id, date, periode);
                }
                await stmt.finalize();
            }
            res.redirect(`/teacher/dashboard/${teacher_id}?success=attendance_saved`);
        } catch (e) {
            res.status(500).send("فشل رصد الغياب");
        }
    });

    app.post('/teacher/behavior/add', async (req, res) => {
        const { student_id, teacher_id, event_text } = req.body;
        const today = new Date().toISOString().split('T')[0];
        try {
            await db.run("INSERT INTO behavior_logs (student_id, teacher_id, event, date) VALUES (?, ?, ?, ?)", 
                [student_id, teacher_id, event_text, today]);
            res.redirect(`/teacher/dashboard/${teacher_id}?success=behavior_added`);
        } catch (e) {
            res.status(500).send("خطأ في تسجيل الملاحظة السلوكية");
        }
    });

    // --- [ الخروج ] ---

    app.get('/logout', (req, res) => {
        res.clearCookie('admin_auth');
        res.redirect('/teacher/login');
    });
    // Route pour retirer une séance affectée (si l'enseignant absent se présente)
// ... الكود السابق (مسار assign-session) ...


// --- [ مسار حذف أو إلغاء الاحتياط - النسخة النهائية الموحدة ] ---
app.get('/admin/substitute/delete/:id', async (req, res) => {
    try {
        const sub_id = req.params.id;
        const reason = req.query.reason; // سيستقبل 'present' من الزر الأخضر
        const today = new Date().toISOString().split('T')[0];

        // 1. جلب بيانات السجل قبل حذفه لمعرفة من هو المعلم الغائب
        const subEntry = await db.get("SELECT absent_id FROM substitute_logs WHERE id = ?", [sub_id]);

        if (subEntry) {
            // 2. حذف سجل الاحتياط من قاعدة البيانات (يحدث في الحالتين)
            await db.run("DELETE FROM substitute_logs WHERE id = ?", [sub_id]);

            // 3. المنطق الجوهري: إذا كان الإلغاء بسبب حضور المعلم
            if (reason === 'present') {
                // حذف سجل غياب المعلم الأصلي لهذا اليوم
                // هذا سيمنع ظهوره مرة أخرى في قائمة "حصص تحتاج إلى بدلاء"
                await db.run("DELETE FROM absences WHERE enseignant_id = ? AND date = ?", [subEntry.absent_id, today]);
                console.log(`تم إلغاء غياب المعلم ID: ${subEntry.absent_id} بسبب حضوره.`);
            }
        }

        let message = (reason === 'present') ? 'teacher_present' : 'substitute_cancelled';
        res.redirect(`/admin/absence-profs?success=${message}`);
    } catch (e) {
        console.error("Error in delete route:", e);
        res.status(500).send("خطأ في معالجة طلب الحذف");
    }
});


// مسار معالجة قبول أو رفض حصة الاحتياط من قبل المعلم
app.post('/teacher/substitute/respond', async (req, res) => {
    try {
        const { sub_id, action, reason } = req.body;
        
        // جلب بيانات الحصة للتوجيه لاحقاً
        const subData = await db.get("SELECT substitute_id FROM substitute_logs WHERE id = ?", [sub_id]);
        if (!subData) return res.status(404).send("الطلب غير موجود");

        if (action === 'accept') {
            // تحديث الحالة إلى مقبول
            await db.run("UPDATE substitute_logs SET status = 'accepted' WHERE id = ?", [sub_id]);
        } 
        else if (action === 'reject') {
            // تحديث الحالة إلى مرفوض مع ذكر السبب
            // ملاحظة: يمكنك حذف السجل أو تركه بحالة 'rejected' ليراه المدير
            await db.run("UPDATE substitute_logs SET status = 'rejected', reject_reason = ? WHERE id = ?", [reason, sub_id]);
        }

        res.redirect(`/teacher/dashboard/${subData.substitute_id}?success=sub_response_sent`);
    } catch (e) {
        console.error(e);
        res.status(500).send("خطأ في معالجة الرد");
    }
});
    app.listen(PORT, () => {
        console.log(`🚀 نظام مدرسة ابن دريد يعمل على: http://localhost:${PORT}`);
    });

});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});