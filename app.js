const express = require('express');
const { Pool } = require('pg'); // تم التغيير من sqlite3 إلى pg
const path = require('path');
const cookieParser = require('cookie-parser');

/**
 * إعدادات التطبيق الأساسية
 */
const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = "admin123"; 

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
            CREATE TABLE IF NOT EXISTS enseignants (id SERIAL PRIMARY KEY, nom TEXT NOT NULL, matiere TEXT, phone_number TEXT, password TEXT DEFAULT '123456', rank TEXT DEFAULT 'معلم', is_admin_duty INTEGER DEFAULT 0, weekly_load INTEGER DEFAULT 0, last_login TEXT);
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

// --- [ نظام التقييم الأكاديمي ] ---

app.get('/teacher/evaluate/:requestId/:studentId', async (req, res) => {
    try {
        const { requestId, studentId } = req.params;
        const requestData = (await pool.query("SELECT enseignant_id FROM evaluation_requests WHERE id = $1", [requestId])).rows[0];
        
        if (!requestData) return res.status(404).send("طلب التقييم هذا غير موجود");

        const teacher_id = requestData.enseignant_id;
        const student = (await pool.query("SELECT * FROM eleves WHERE id = $1", [parseInt(studentId)])).rows[0];
        
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

        await pool.query(`INSERT INTO academic_evaluations (eleve_id, enseignant_id, level, remark, date_submission) VALUES ($1, $2, $3, $4, $5)`, 
            [student_id, teacher_id, level, remark, date_now]);

        await pool.query("UPDATE evaluation_requests SET status = 'completed' WHERE id = $1", [request_id]);
        res.redirect(`/teacher/dashboard/${teacher_id}?success=evaluated`);
    } catch (e) {
        console.error(e);
        res.status(500).send("خطأ أثناء حفظ التقييم");
    }
});

app.post('/admin/students/request-evaluation', async (req, res) => {
    try {
        const { student_id } = req.body;
        if (!student_id) return res.status(400).send("لم يتم اختيار طالب");

        const student = (await pool.query("SELECT * FROM eleves WHERE id = $1", [parseInt(student_id)])).rows[0];
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
            const teachersCount = (await pool.query("SELECT COUNT(*) as c FROM enseignants")).rows[0].c;
            const studentsCount = (await pool.query("SELECT COUNT(*) as c FROM eleves")).rows[0].c;
            const absenceCount = (await pool.query("SELECT COUNT(*) as c FROM absences WHERE date = CURRENT_DATE::text")).rows[0].c;
            
            res.render('admin_dashboard', { 
                ecole: "مدرسة ابن دريد", 
                titre: "لوحة التحكم", 
                stats: { teachers: teachersCount, students: studentsCount, absences: absenceCount } 
            });
        } catch (e) {
            res.status(500).send("خطأ في جلب إحصائيات اللوحة");
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
            const selectedClasses = JSON.parse(classes_data);
            const currentTeacher = (await pool.query("SELECT nom, matiere FROM enseignants WHERE id = $1", [enseignant_id])).rows[0];
            
            if (!currentTeacher) return res.status(404).send("المعلم غير موجود");

            for (const item of selectedClasses) {
                const [classe, section] = item.split('|');
                const conflict = (await pool.query(`
                    SELECT e.nom FROM affectations a 
                    JOIN enseignants e ON a.enseignant_id = e.id 
                    WHERE a.classe = $1 AND a.section = $2 AND e.matiere = $3
                `, [classe, section, currentTeacher.matiere])).rows[0];

                if (conflict) {
                    return res.send(`<script>alert("خطأ: الفصل ${classe} (${section}) مسند بالفعل لمدرس مادة ${currentTeacher.matiere} آخر وهو: ${conflict.nom}"); window.location.href = "/admin/enseignants";</script>`);
                }

                const exists = (await pool.query("SELECT id FROM affectations WHERE enseignant_id = $1 AND classe = $2 AND section = $3", [enseignant_id, classe, section])).rows[0];
                if (!exists) {
                    await pool.query("INSERT INTO affectations (enseignant_id, classe, section) VALUES ($1, $2, $3)", [enseignant_id, classe, section]);
                }
            }
            res.redirect('/admin/enseignants');
        } catch (e) { res.status(500).send("خطأ في تعيين الأقسام"); }
    });

    // --- [ 5. إدارة الجدول الزمني ] ---

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

    // --- [ 6. إدارة غياب المعلمين والاحتياط ] ---

    app.get('/admin/absence-profs', async (req, res) => {
        try {
            const today = new Date().toISOString().split('T')[0];
            const days = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
            const todayName = days[new Date().getDay()];

            const enseignants = (await pool.query("SELECT * FROM enseignants ORDER BY nom ASC")).rows;
            const ghaibeen = (await pool.query(`
                SELECT DISTINCT e.id as teacher_id, e.nom, e.matiere, t.periode, t.classe, t.section
                FROM absences a JOIN enseignants e ON a.enseignant_id = e.id JOIN timetable t ON e.id = t.enseignant_id
                WHERE a.date = $1 AND (t.jour = $2 OR t.jour = REPLACE($2, 'إ', 'ا'))
                AND NOT EXISTS (
                    SELECT 1 FROM substitute_logs sl WHERE sl.absent_id = e.id AND sl.date = a.date 
                    AND sl.periode = t.periode AND sl.status IN ('accepted', 'pending')
                ) ORDER BY t.periode ASC`, [today, todayName])).rows;

            const suggestions = (await pool.query(`
                SELECT e.*, (SELECT COUNT(*) FROM substitute_logs WHERE substitute_id = e.id AND EXTRACT(MONTH FROM TO_DATE(date, 'YYYY-MM-DD')) = EXTRACT(MONTH FROM CURRENT_DATE)) as reserve_this_month
                FROM enseignants e WHERE e.id NOT IN (SELECT enseignant_id FROM absences WHERE date = $1)
                ORDER BY reserve_this_month ASC, weekly_load ASC`, [today])).rows;

            const recapSubstitutions = (await pool.query(`
                SELECT sl.*, sub.nom as substitute_name, abs_p.nom as absent_name 
                FROM substitute_logs sl LEFT JOIN enseignants sub ON sl.substitute_id = sub.id LEFT JOIN enseignants abs_p ON sl.absent_id = abs_p.id
                WHERE sl.date = $1 ORDER BY sl.periode ASC`, [today])).rows;

            res.render('gestion_absences', { enseignants, ghaibeen, suggestions, today, recapSubstitutions, titre: "توزيع حصص الاحتياط" });
        } catch (e) { res.status(500).send("خطأ في نظام الاحتياط: " + e.message); }
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
            const eleves = (await pool.query("SELECT * FROM eleves ORDER BY classe, section, nom")).rows;
            const classes = (await pool.query("SELECT * FROM school_classes")).rows;
            res.render('gestion_eleves', { eleves, classes, titre: "إدارة سجلات الطلاب" });
        } catch (e) { res.status(500).send("خطأ في تحميل سجل الطلاب"); }
    });

    app.post('/admin/eleves/ajouter', async (req, res) => {
        try {
            const { nom, class_info, parent_phone } = req.body;
            const [classe, section] = class_info.split('|');
            await pool.query("INSERT INTO eleves (nom, classe, section, parent_phone) VALUES ($1, $2, $3, $4)", [nom, classe, section, parent_phone]);
            res.redirect('/admin/eleves?success=added');
        } catch (e) { res.redirect('/admin/eleves?error=add_failed'); }
    });

    app.post('/admin/eleves/modifier', async (req, res) => {
        try {
            const { id, nom, class_info, parent_phone } = req.body;
            const [classe, section] = class_info.split('|');
            await pool.query("UPDATE eleves SET nom = $1, classe = $2, section = $3, parent_phone = $4 WHERE id = $5", [nom, classe, section, parent_phone, id]);
            res.redirect('/admin/eleves?success=updated');
        } catch (e) { res.redirect('/admin/eleves?error=update_failed'); }
    });
//222222222222
   // --- [ 11. رصد غياب الطلاب والسلوك (من جهة المعلم) ] ---

    app.post('/teacher/absences/mark', async (req, res) => {
        const { teacher_id, date, periode, student_ids } = req.body;
        try {
            // حذف السجلات القديمة لنفس الحصة لتجنب التكرار
            await pool.query("DELETE FROM student_absences WHERE enseignant_id = $1 AND date = $2 AND periode = $3", [teacher_id, date, periode]);
            
            if (student_ids) {
                const ids = Array.isArray(student_ids) ? student_ids : [student_ids];
                // في PostgreSQL نستخدم الـ Loop لإدخال القيم
                for (let id of ids) {
                    await pool.query("INSERT INTO student_absences (eleve_id, enseignant_id, date, periode) VALUES ($1, $2, $3, $4)", 
                        [id, teacher_id, date, periode]);
                }
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

    app.post('/admin/enseignants/desaffecter', async (req, res) => {
        try {
            const { id } = req.body;
            await pool.query("DELETE FROM affectations WHERE id = $1", [id]);
            res.redirect('/admin/enseignants?success=deassigned');
        } catch (e) {
            res.status(500).send("خطأ في إلغاء الإسناد");
        }
    });

    app.get('/admin/timetable/supprimer/:id', async (req, res) => {
        try {
            await pool.query("DELETE FROM timetable WHERE id = $1", [req.params.id]);
            res.redirect('/admin/timetable?success=deleted');
        } catch (e) {
            res.redirect('/admin/timetable?error=delete_failed');
        }
    });

    // --- [ التقارير الشاملة ] ---

    app.get('/admin/student/full-report/:id', async (req, res) => {
        try {
            const studentId = req.params.id;
            const student = (await pool.query("SELECT * FROM eleves WHERE id = $1", [studentId])).rows[0];
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
                FROM eleves e JOIN academic_evaluations ae ON e.id = ae.eleve_id`)).rows;
            const all_students = (await pool.query("SELECT id, nom, classe FROM eleves ORDER BY nom ASC")).rows;
            
            res.render('admin_evaluations_list', { 
                students: studentsWithEvals, 
                all_students: all_students, 
                titre: "إدارة التقييمات الأكاديمية" 
            });
        } catch (e) {
            res.status(500).send("خطأ في جلب قائمة التقييمات");
        }
    });

    app.get('/admin/students', (req, res) => res.redirect('/admin/eleves'));





    // --- [ إضافة مسارات لوحة المعلم الكاملة ] ---



// مسار قبول أو رفض حصة الاحتياط من قبل المعلم
app.post('/teacher/substitute/respond', async (req, res) => {
    try {
        const { sub_id, action, teacher_id } = req.body; 

        if (action === 'accept') {
            await pool.query(
                "UPDATE substitute_logs SET status = 'accepted' WHERE id = $1",
                [sub_id]
            );
        }

        // بدلاً من 'back'، نوجه المعلم إلى لوحة تحكمه مباشرة باستخدام معرفه
        if (teacher_id) {
            res.redirect(`/teacher/dashboard/${teacher_id}`);
        } else {
            // في حال عدم وجود معرف، نعود للصفحة الرئيسية للمعلمين
            res.redirect('/teacher/login');
        }
    } catch (e) {
        console.error("Error in respond path:", e);
        res.status(500).send("خطأ في معالجة الطلب");
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
        // جلب أسماء المعلمين من Supabase لعرضهم في القائمة المنسدلة
        const result = await pool.query("SELECT id, nom FROM enseignants ORDER BY nom ASC");
        const enseignants = result.rows;
        
        // عرض صفحة login وإرسال قائمة المعلمين لها
        res.render('teacher_login', { 
            enseignants, 
            error: null, 
            titre: "دخول المعلمين" 
        });
    } catch (e) {
        console.error("Login Page Error:", e);
        res.status(500).send("خطأ في تحميل صفحة الدخول");
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

// 7. تحديث توقيت الحصص المدرسية
app.post('/admin/settings/periods/update', isAdmin, async (req, res) => {
    try {
        // البيانات تصل كمصفوفات بسبب استخدام [] في أسماء الحقول في الـ EJS
        const { id, start_time, end_time } = req.body;

        // التأكد من وجود بيانات
        if (id && Array.isArray(id)) {
            for (let i = 0; i < id.length; i++) {
                const periodId = id[i];
                const start = start_time[i];
                const end = end_time[i];

                // نستخدم UPSERT (إدخال أو تحديث) لضمان وجود التوقيت في قاعدة البيانات
                await pool.query(`
                    INSERT INTO school_periods (id, start_time, end_time)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (id) 
                    DO UPDATE SET start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time
                `, [periodId, start, end]);
            }
        }

        res.redirect('/admin/settings?success=periods_updated');
    } catch (e) {
        console.error("Error updating periods:", e);
        res.status(500).send("خطأ في تحديث توقيت الحصص");
    }
});
// 8. التحقق من بيانات دخول المعلم
app.post('/teacher/login', async (req, res) => {
    try {
        const { teacher_id, password } = req.body;

        // التحقق من وجود المعلم وكلمة المرور في قاعدة البيانات
        const result = await pool.query(
            "SELECT * FROM enseignants WHERE id = $1 AND password = $2", 
            [teacher_id, password]
        );

        const user = result.rows[0];

        if (user) {
            // حفظ هوية المعلم في الكوكيز للوصول إليها في لوحة التحكم
            res.cookie('teacher_auth', user.id, { 
                httpOnly: true, 
                maxAge: 24 * 60 * 60 * 1000 // صالح لمدة يوم واحد
            });
            
            // التوجيه إلى لوحة تحكم المعلم الخاصة به
            res.redirect(`/teacher/dashboard/${user.id}`);
        } else {
            // في حال كانت البيانات خاطئة، نعيد تحميل صفحة الدخول مع رسالة خطأ
            const enseignants = (await pool.query("SELECT id, nom FROM enseignants ORDER BY nom ASC")).rows;
            res.render('teacher_login', { 
                enseignants, 
                error: "كلمة المرور غير صحيحة، يرجى المحاولة مرة أخرى", 
                titre: "دخول المعلمين" 
            });
        }
    } catch (e) {
        console.error("Login Post Error:", e);
        res.status(500).send("خطأ في عملية تسجيل الدخول");
    }
});
app.get('/teacher/dashboard/:id', async (req, res) => {
    const teacher_id = parseInt(req.params.id);
    if (isNaN(teacher_id)) return res.redirect('/teacher/login');

    try {
        const todayDate = new Date().toISOString().split('T')[0];
        const days = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
        const todayName = days[new Date().getDay()];

        const profRes = await pool.query("SELECT * FROM enseignants WHERE id = $1", [teacher_id]);
        const prof = profRes.rows[0];
        if (!prof) return res.status(404).send("المعلم غير موجود");

        const fetchSafe = async (query, params = []) => {
            try { return (await pool.query(query, params)).rows; } 
            catch (e) { 
                console.error("❌ فشل استعلام محدد:", e.message); 
                return []; 
            }
        };

        const periods = await fetchSafe("SELECT * FROM school_periods ORDER BY id ASC");
        
        // --- تحديث: جلب الحصص العادية وحصص الاحتياط المقبولة معاً ---
        const sessionsQuery = `
            SELECT periode, classe, section, false as is_substitute 
            FROM timetable 
            WHERE enseignant_id = $1 AND (jour = $2 OR jour = REPLACE($2, 'إ', 'ا'))
            
            UNION ALL
            
            SELECT periode, classe, section, true as is_substitute 
            FROM substitute_logs 
            WHERE substitute_id = $1 AND date::date = $3::date AND status = 'accepted'
            
            ORDER BY periode ASC
        `;
        const sessions = await fetchSafe(sessionsQuery, [teacher_id, todayName, todayDate]);
        // ---------------------------------------------------------
        
        const students = await fetchSafe("SELECT id, nom, classe, section FROM eleves ORDER BY nom ASC");
        const announcements = await fetchSafe("SELECT * FROM announcements ORDER BY id DESC LIMIT 5");
        
        const evalRequests = await fetchSafe(`
            SELECT er.*, e.nom as student_name FROM evaluation_requests er 
            JOIN eleves e ON er.eleve_id = e.id 
            WHERE er.enseignant_id = $1 AND er.status = 'pending'
        `, [teacher_id]);

        const pendingRequests = await fetchSafe(`
            SELECT sl.*, e.nom as absent_name FROM substitute_logs sl 
            JOIN enseignants e ON sl.absent_id = e.id 
            WHERE sl.substitute_id = $1 AND sl.date::date = $2::date AND sl.status = 'pending'
        `, [teacher_id, todayDate]);

        res.render('teacher_dashboard', {
            prof,
            periods: periods.length > 0 ? periods : Array.from({length:8}, (_,i)=>({id:i+1, start_time:'00:00', end_time:'00:00'})),
            sessions,
            students,
            announcements,
            evalRequests,
            pendingRequests,
            todayDate,
            todayName,
            titre: "لوحة المعلم"
        });

    } catch (e) {
        console.error("Dashboard Error:", e.message);
        res.status(500).send("خطأ في تحميل البيانات");
    }
});
// 10. إضافة إعلان جديد من قبل الإدارة
app.post('/admin/announcements/add', isAdmin, async (req, res) => {
    try {
        const { title, content } = req.body;
        const date = new Date().toLocaleDateString('ar-EG');

        if (!title || !content) {
            return res.status(400).send("العنوان والمحتوى مطلوبان");
        }

        // إدخال الإعلان في جدول announcements
        await pool.query(
            "INSERT INTO announcements (title, content, date) VALUES ($1, $2, $3)",
            [title, content, date]
        );

        // العودة للوحة تحكم الإدارة مع رسالة نجاح
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
        const todayDate = new Date().toISOString().split('T')[0];
        const days = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
        const todayName = days[new Date().getDay()];

        if (!substitute_id) {
            const autoRes = await pool.query(`
                SELECT id FROM enseignants 
                WHERE id NOT IN (
                    SELECT enseignant_id FROM timetable 
                    WHERE periode = $1 AND (jour = $2 OR jour = REPLACE($2, 'إ', 'ا'))
                )
                AND id != $3
                ORDER BY monthly_reserve ASC, weekly_load ASC 
                LIMIT 1`, [periode, todayName, absent_id]);
            
            if (autoRes.rows.length === 0) {
                // بدلاً من res.send، نعود للخلف مع رسالة خطأ
                return res.redirect('/admin/substitute?error=no_teacher');
            }
            substitute_id = autoRes.rows[0].id;
        }

        await pool.query(
            `INSERT INTO substitute_logs (absent_id, substitute_id, periode, classe, section, date, status) 
             VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
            [absent_id, substitute_id, periode, classe, section, todayDate]
        );

        await pool.query("UPDATE enseignants SET monthly_reserve = COALESCE(monthly_reserve, 0) + 1 WHERE id = $1", [substitute_id]);

        res.redirect('/admin/substitute?success=assigned');
    } catch (e) {
        console.error(e);
        res.redirect('/admin/substitute?error=db_error');
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
                COUNT(DISTINCT a.date::date) as total_absences_days -- حساب الأيام الفريدة فقط
            FROM eleves e
            LEFT JOIN absences a ON e.id = a.eleve_id
            GROUP BY e.id, e.nom, e.classe, e.section
            ORDER BY total_absences_days DESC;
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

    // --- [ تشغيل الخادم ] ---
    app.listen(PORT, () => {
        console.log(`🚀 نظام مدرسة ابن دريد يعمل على: http://localhost:${PORT}`);
    });

});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});