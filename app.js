const express = require('express'); // أضف هذا السطر إذا لم يكن موجوداً في الأعلى
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');
const cookieParser = require('cookie-parser');

/**
 * إعدادات التطبيق الأساسية
 */
const app = express(); // تم نقل التعريف إلى هنا (قبل أي استخدام لـ app.use)

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = "admin123"; 

// الإعدادات (Middleware)
app.use(cookieParser());
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true })); // هذا السطر الآن يعمل بشكل صحيح
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
            /* جدول طلبات التقييم المرسلة من الإدارة */
CREATE TABLE IF NOT EXISTS evaluation_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    eleve_id INTEGER NOT NULL,
    enseignant_id INTEGER NOT NULL, 
    date_request TEXT NOT NULL,
    status TEXT DEFAULT 'pending', -- 'pending' أو 'completed'
    FOREIGN KEY(eleve_id) REFERENCES eleves(id) ON DELETE CASCADE,
    FOREIGN KEY(enseignant_id) REFERENCES enseignants(id) ON DELETE CASCADE
);

/* جدول نتائج التقييم الأكاديمي التفصيلي */
CREATE TABLE IF NOT EXISTS academic_evaluations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    eleve_id INTEGER NOT NULL,
    enseignant_id INTEGER NOT NULL,
    level TEXT NOT NULL, -- ممتاز، جيد جداً، الخ
    remark TEXT,
    date_submission TEXT NOT NULL,
    FOREIGN KEY(eleve_id) REFERENCES eleves(id) ON DELETE CASCADE,
    FOREIGN KEY(enseignant_id) REFERENCES enseignants(id) ON DELETE CASCADE
);

            
        `);

      const columnsToAdd = [
    { table: 'eleves', col: 'parent_phone', type: 'TEXT' }, // السطر الناقص الذي يسبب الخطأ
    { table: 'substitute_logs', col: 'absent_id', type: 'INTEGER' },
    { table: 'substitute_logs', col: 'substitute_id', type: 'INTEGER' },
    { table: 'substitute_logs', col: 'periode', type: 'INTEGER' },
    { table: 'substitute_logs', col: 'classe', type: 'TEXT' },
    { table: 'substitute_logs', col: 'section', type: 'TEXT' },
    { table: 'substitute_logs', col: 'status', type: "TEXT DEFAULT 'pending'" },
    { table: 'substitute_logs', col: 'reject_reason', type: "TEXT" },
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



    // --- [ نظام التقييم الأكاديمي ] ---

// 1. عرض صفحة التقييم للمعلم
app.get('/teacher/evaluate/:requestId/:studentId', async (req, res) => {
    try {
        const { requestId, studentId } = req.params;

        // 1. جلب معرف المعلم من الجلسة (Session) - الطريقة الأكثر أماناً
        // إذا كنت تستخدم نظام تسجيل دخول، المعرف موجود في req.session.user.id
        // أو يمكنك جلبه من جدول الطلبات نفسه بما أننا نملك requestId
        
        const requestData = await db.get("SELECT enseignant_id FROM evaluation_requests WHERE id = ?", [requestId]);
        
        if (!requestData) {
            return res.status(404).send("طلب التقييم هذا غير موجود");
        }

        const teacher_id = requestData.enseignant_id;

        // 2. جلب بيانات الطالب
        const student = await db.get("SELECT * FROM eleves WHERE id = ?", [parseInt(studentId)]);
        
        if (!student) return res.status(404).send("الطالب غير موجود");

        // 3. إرسال البيانات للـ EJS (تأكد من إرسال teacher_id)
        res.render('teacher_evaluation', { 
            student, 
            requestId, 
            teacher_id, // الآن المتغير معرف ولن يظهر الخطأ
            titre: "تقييم المستوى الأكاديمي" 
        });
    } catch (e) {
        console.error(e);
        res.status(500).send("خطأ في تحميل الصفحة");
    }
});

// 2. استقبال التقييم وحفظه
app.post('/teacher/evaluate/submit', async (req, res) => {
    try {
        const { student_id, level, remark, request_id, teacher_id } = req.body;
        const date_now = new Date().toISOString().split('T')[0];

        // حفظ التقييم في جدول academic_evaluations
        await db.run(`
            INSERT INTO academic_evaluations (eleve_id, enseignant_id, level, remark, date_submission) 
            VALUES (?, ?, ?, ?, ?)`, 
            [student_id, teacher_id, level, remark, date_now]
        );

        // تحديث حالة الطلب في جدول evaluation_requests لكي يختفي من لوحة المعلم
        await db.run("UPDATE evaluation_requests SET status = 'completed' WHERE id = ?", [request_id]);

        // إعادة التوجيه للوحة التحكم مع رسالة نجاح
        res.redirect(`/teacher/dashboard/${teacher_id}?success=evaluated`);
    } catch (e) {
        console.error(e);
        res.status(500).send("خطأ أثناء حفظ التقييم");
    }
});

// 3. مسار إرسال طلب التقييم (من الأدمن لجميع مدرسي طالب معين)
app.post('/admin/students/request-evaluation', async (req, res) => {
    try {
        // 1. طباعة البيانات المستلمة للتأكد من وصول ID الطالب
        console.log("--- بداية عملية طلب التقييم ---");
        console.log("البيانات المستلمة من الـ Form:", req.body);

        const { student_id } = req.body;

        if (!student_id) {
            console.error("خطأ: لم يتم إرسال student_id في الطلب!");
            return res.status(400).send("لم يتم اختيار طالب");
        }

        // 2. البحث عن الطالب (مع التأكد من تحويل النوع إلى رقم)
        const student = await db.get("SELECT * FROM eleves WHERE id = ?", [parseInt(student_id)]);
        
        if (!student) {
            console.error(`خطأ: الطالب الذي يحمل الرقم (${student_id}) غير موجود في جدول eleves`);
            // لنتأكد من وجود طلاب، اطبع أول 3 طلاب في الجدول للتجربة
            const sample = await db.all("SELECT id, nom FROM eleves LIMIT 3");
            console.log("أمثلة لطلاب موجودين في القاعدة:", sample);
            
            return res.status(404).send("عذراً، الطالب غير موجود في قاعدة البيانات");
        }

        // 3. جلب المدرسين المرتبطين (تأكد من اسم جدول التوزيع لديك)
        const teachers = await db.all("SELECT enseignant_id FROM affectations WHERE classe = ? AND section = ?", 
            [student.classe, student.section]);

        console.log(`تم العثور على ${teachers.length} مدرسين لهذا الطالب`);

        const date_request = new Date().toISOString().split('T')[0];

        // 4. تسجيل الطلبات
        for (const t of teachers) {
            await db.run(
                "INSERT INTO evaluation_requests (eleve_id, enseignant_id, date_request, status) VALUES (?, ?, ?, 'pending')", 
                [student.id, t.enseignant_id, date_request]
            );
        }

        console.log("تم إرسال الطلبات بنجاح");
        res.redirect('/admin/student-reports-list?success=1');

    } catch (e) {
        console.error("خطأ تقني فادح:", e);
        res.status(500).send("حدث خطأ أثناء معالجة طلبك");
    }
});

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
    // مسار تحديث بيانات المعلم
app.post('/admin/enseignants/modifier', async (req, res) => {
    try {
        const { id, nom, matiere, phone_number } = req.body;
        
        await db.run(
            "UPDATE enseignants SET nom = ?, matiere = ?, phone_number = ? WHERE id = ?", 
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
        const selectedClasses = JSON.parse(classes_data);
        
        // 1. جلب مادة المعلم الحالي أولاً
        const currentTeacher = await db.get("SELECT nom, matiere FROM enseignants WHERE id = ?", [enseignant_id]);
        
        if (!currentTeacher) {
            return res.status(404).send("المعلم غير موجود");
        }

        for (const item of selectedClasses) {
            const [classe, section] = item.split('|');

            // 2. التحقق: هل يوجد معلم آخر يدرس "نفس المادة" لهذا "الفصل والشعبة"؟
            const conflict = await db.get(`
                SELECT e.nom 
                FROM affectations a 
                JOIN enseignants e ON a.enseignant_id = e.id 
                WHERE a.classe = ? AND a.section = ? AND e.matiere = ?
            `, [classe, section, currentTeacher.matiere]);

            if (conflict) {
                // إذا وجدنا مدرساً آخر لنفس المادة، نرسل تنبيهاً ونوقف العملية
                return res.send(`
                    <script>
                        alert("خطأ: الفصل ${classe} (${section}) مسند بالفعل لمدرس مادة ${currentTeacher.matiere} آخر وهو: ${conflict.nom}");
                        window.location.href = "/admin/enseignants";
                    </script>
                `);
            }

            // 3. إذا لم يوجد تعارض، نتحقق من عدم التكرار لنفس المدرس (كما في كودك القديم) ثم نضيف
            const exists = await db.get("SELECT id FROM affectations WHERE enseignant_id = ? AND classe = ? AND section = ?", [enseignant_id, classe, section]);
            if (!exists) {
                await db.run("INSERT INTO affectations (enseignant_id, classe, section) VALUES (?, ?, ?)", [enseignant_id, classe, section]);
            }
        }
        res.redirect('/admin/enseignants');
    } catch (e) {
        console.error(e);
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

        // 1. التحقق: هل المعلم مشغول في هذا الوقت؟
        const teacherConflict = await db.get("SELECT id FROM timetable WHERE enseignant_id = ? AND jour = ? AND periode = ?", [enseignant_id, jour, periode]);
        if (teacherConflict) return res.redirect('/admin/timetable?error=teacher_busy');

        // 2. التحقق: هل الفصل مشغول في هذا الوقت؟
        const classConflict = await db.get("SELECT id FROM timetable WHERE classe = ? AND section = ? AND jour = ? AND periode = ?", [classe, section, jour, periode]);
        if (classConflict) return res.redirect('/admin/timetable?error=class_busy');

        // 3. الإضافة إذا لم يوجد تعارض
        await db.run("INSERT INTO timetable (enseignant_id, classe, section, jour, periode, matiere) VALUES (?, ?, ?, ?, ?, ?)",
            [enseignant_id, classe, section, jour, periode, prof.matiere]);
            
        res.redirect('/admin/timetable?success=added');
    } catch (e) {
        console.error(e);
        res.redirect('/admin/timetable?error=server');
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

    // 1. إضافة طالب مع رقم هاتف ولي الأمر
app.post('/admin/eleves/ajouter', async (req, res) => {
    try {
        const { nom, class_info, parent_phone } = req.body;
        const [classe, section] = class_info.split('|');
        await db.run("INSERT INTO eleves (nom, classe, section, parent_phone) VALUES (?, ?, ?, ?)", 
            [nom, classe, section, parent_phone]);
        res.redirect('/admin/eleves?success=added');
    } catch (e) {
        res.redirect('/admin/eleves?error=add_failed');
    }
});

// 2. حذف طالب
app.get('/admin/eleves/supprimer/:id', async (req, res) => {
    try {
        await db.run("DELETE FROM eleves WHERE id = ?", [req.params.id]);
        res.redirect('/admin/eleves?success=deleted');
    } catch (e) {
        res.redirect('/admin/eleves?error=delete_failed');
    }
});

// 3. تعديل بيانات طالب (جديد)
app.post('/admin/eleves/modifier', async (req, res) => {
    try {
        const { id, nom, class_info, parent_phone } = req.body;
        const [classe, section] = class_info.split('|');
        await db.run("UPDATE eleves SET nom = ?, classe = ?, section = ?, parent_phone = ? WHERE id = ?", 
            [nom, classe, section, parent_phone, id]);
        res.redirect('/admin/eleves?success=updated');
    } catch (e) {
        res.redirect('/admin/eleves?error=update_failed');
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
        const todayDate = now.toISOString().split('T')[0];

        // 1. جلب البيانات الأساسية
        const periods = await db.all("SELECT * FROM school_periods ORDER BY id ASC") || [];
        const announcements = await db.all("SELECT * FROM announcements ORDER BY id DESC LIMIT 5") || [];
        const students = await db.all("SELECT * FROM eleves") || [];

        // --- التعديل الجديد: جلب طلبات التقييم الأكاديمي المعلقة لهذا المعلم ---
        const evalRequests = await db.all(`
            SELECT er.id, er.eleve_id, e.nom as student_name, e.classe, e.section 
            FROM evaluation_requests er
            JOIN eleves e ON er.eleve_id = e.id
            WHERE er.enseignant_id = ? AND er.status = 'pending'
        `, [teacher_id]) || [];

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
            WHERE sl.substitute_id = ? 
            AND sl.date = ?
            AND (sl.status = 'pending' OR sl.status = 'accepted')
        `, [teacher_id, todayDate]) || [];

        // 4. معالجة بيانات الاحتياط (Mapping)
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

        // 5. تصفية الحصص
        const activeSessions = [
            ...sessions, 
            ...mappedSubs.filter(s => s.status === 'accepted')
        ];

        const pendingRequests = mappedSubs.filter(s => s.status === 'pending');

        // 6. إرسال كل البيانات للوحة التحكم (تأكد من إضافة evalRequests هنا)
        res.render('teacher_dashboard', { 
            prof, 
            sessions: activeSessions,
            pendingRequests,
            evalRequests, // ممرر إلى EJS
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


app.post('/admin/enseignants/modifier', async (req, res) => {
    const { id, nom, matiere, phone_number } = req.body;
    try {
        await db.run(
            "UPDATE enseignants SET nom = ?, matiere = ?, phone_number = ? WHERE id = ?", 
            [nom, matiere, phone_number, id]
        );
        res.redirect('/admin/enseignants?success=teacher_updated');
    } catch (e) {
        console.error(e);
        res.status(500).send("خطأ أثناء تحديث بيانات المعلم");
    }
});
// مسار إلغاء إسناد فصل من معلم
app.post('/admin/enseignants/desaffecter', async (req, res) => {
    try {
        const { id } = req.body; // استلام معرف التعيين من الفورم
        if (!id) {
            return res.status(400).send("معرف التعيين مفقود");
        }
        
        await db.run("DELETE FROM affectations WHERE id = ?", [id]);
        
        // إعادة التوجيه لنفس الصفحة مع رسالة نجاح (اختياري)
        res.redirect('/admin/enseignants?success=deassigned');
    } catch (e) {
        console.error("Error during de-assignment:", e);
        res.status(500).send("حدث خطأ أثناء محاولة حذف التعيين");
    }
});


app.get('/admin/timetable/supprimer/:id', async (req, res) => {
    try {
        await db.run("DELETE FROM timetable WHERE id = ?", [req.params.id]);
        res.redirect('/admin/timetable?success=deleted');
    } catch (e) {
        res.redirect('/admin/timetable?error=delete_failed');
    }
});

app.post('/admin/enseignants/desaffecter', async (req, res) => {
    try {
        const { id } = req.body;
        await db.run("DELETE FROM affectations WHERE id = ?", [id]);
        res.redirect('/admin/enseignants?success=deassigned');
    } catch (e) {
        res.status(500).send("خطأ في إلغاء الإسناد");
    }
});
// --- [ نظام التقييم الأكاديمي ] ---

// 1. عرض صفحة التقييم للمعلم
// الترتيب الصحيح ليطابق الرابط في صفحة EJS
app.get('/teacher/evaluate/:requestId/:studentId', async (req, res) => {
    try {
        const { requestId, studentId } = req.params;
        const teacher_id = req.query.teacher_id; 

        // تأكد من تحويل studentId إلى رقم
        const student = await db.get("SELECT * FROM eleves WHERE id = ?", [parseInt(studentId)]);
        
        if (!student) {
            console.error(`الطالب برقم ${studentId} غير موجود في القاعدة`);
            return res.status(404).send("الطالب غير موجود");
        }

        res.render('teacher_evaluation', { 
            student, 
            requestId, 
            teacher_id, 
            titre: "تقييم المستوى الأكاديمي" 
        });
    } catch (e) {
        console.error(e);
        res.status(500).send("خطأ في تحميل الصفحة");
    }
});

// 2. استقبال التقييم وحفظه في قاعدة البيانات
app.post('/teacher/evaluate/submit', async (req, res) => {
    try {
        const { student_id, level, remark, request_id, teacher_id } = req.body;
        const date_now = new Date().toISOString().split('T')[0];

        // حفظ التقييم في جدول academic_evaluations (الذي أنشأته أنت سابقاً)
        await db.run(`
            INSERT INTO academic_evaluations (eleve_id, enseignant_id, level, remark, date_submission) 
            VALUES (?, ?, ?, ?, ?)`, 
            [student_id, teacher_id, level, remark, date_now]
        );

        // تحديث حالة الطلب لكي يختفي من لوحة المعلم
        await db.run("UPDATE evaluation_requests SET status = 'completed' WHERE id = ?", [request_id]);

        res.redirect(`/teacher/dashboard/${teacher_id}?success=evaluated`);
    } catch (e) {
        console.error(e);
        res.status(500).send("خطأ أثناء حفظ التقييم");
    }
});
// --- [ مسار توليد التقرير الشامل للطالب ] ---
app.get('/admin/student/full-report/:id', async (req, res) => {
    try {
        const studentId = req.params.id;

        const student = await db.get("SELECT * FROM eleves WHERE id = ?", [studentId]);
        if (!student) return res.status(404).send("الطالب غير موجود");

        const absences = await db.all("SELECT * FROM student_absences WHERE eleve_id = ?", [studentId]);

        // تم التعديل هنا لتطابق مسميات ملفك القديم
        const behaviors = await db.all(`
            SELECT date AS created_at, event AS event_text 
            FROM behavior_logs 
            WHERE student_id = ?
        `, [studentId]);

        const evaluations = await db.all(`
            SELECT ae.*, e.nom as teacher_name 
            FROM academic_evaluations ae
            JOIN enseignants e ON ae.enseignant_id = e.id
            WHERE ae.eleve_id = ?
        `, [studentId]);

        res.render('student_report', { 
            student, 
            absences, 
            behaviors, 
            evaluations, 
            titre: "تقرير الطالب الشامل" 
        });

    } catch (e) {
        console.error("Report Error:", e);
        res.status(500).send("خطأ أثناء استخراج التقرير: " + e.message);
    }
});
// مسار عرض قائمة الطلاب الذين لديهم تقييمات (ليعمل زر لوحة التحكم)
app.get('/admin/student-reports-list', async (req, res) => {
    try {
        // 1. جلب الطلاب الذين لديهم تقييمات مكتملة (لعرضهم في الجدول)
        const studentsWithEvals = await db.all(`
            SELECT DISTINCT e.id, e.nom, e.classe, e.section 
            FROM eleves e
            JOIN academic_evaluations ae ON e.id = ae.eleve_id
        `);

        // 2. جلب قائمة بجميع الطلاب (ليظهروا في النافذة المنبثقة عند طلب تقييم جديد)
        const all_students = await db.all("SELECT id, nom, classe FROM eleves ORDER BY nom ASC");
        
        // 3. إرسال البيانات للملف
        res.render('admin_evaluations_list', { 
            students: studentsWithEvals, 
            all_students: all_students, // هذا السطر هو الذي يمنع الخطأ في الصفحة
            titre: "إدارة التقييمات الأكاديمية" 
        });
    } catch (e) {
        console.error("Error loading evaluation list:", e);
        res.status(500).send("خطأ في جلب قائمة التقييمات");
    }
});
app.get('/admin/students', (req, res) => res.redirect('/admin/eleves'));
    app.listen(PORT, () => {
        console.log(`🚀 نظام مدرسة ابن دريد يعمل على: http://localhost:${PORT}`);
    });

});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});