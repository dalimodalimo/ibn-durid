const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

async function setup() {
    try {
        const db = await open({
            filename: './ecole_ibn_durid.db',
            driver: sqlite3.Database
        });

        // 1. إنشاء الجداول الأساسية
        await db.exec(`
            CREATE TABLE IF NOT EXISTS eleves (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                nom TEXT,
                classe TEXT,
                section TEXT
            );

            CREATE TABLE IF NOT EXISTS enseignants (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                nom TEXT,
                matiere TEXT,
                phone_number TEXT,
                password TEXT DEFAULT '123456'
            );

            CREATE TABLE IF NOT EXISTS affectations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                enseignant_id INTEGER,
                classe TEXT,
                section TEXT,
                FOREIGN KEY(enseignant_id) REFERENCES enseignants(id)
            );

            CREATE TABLE IF NOT EXISTS substitute_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                enseignant_id INTEGER,
                date TEXT,
                FOREIGN KEY(enseignant_id) REFERENCES enseignants(id)
            );
        `);

        // 2. تحديث جدول المعلمين بأعمدة سياسة الاحتياط (مع التحقق من وجودها)
        const columns = await db.all("PRAGMA table_info(enseignants)");
        const columnNames = columns.map(c => c.name);

        if (!columnNames.includes('is_admin_duty')) {
            await db.exec("ALTER TABLE enseignants ADD COLUMN is_admin_duty INTEGER DEFAULT 0;");
        }
        if (!columnNames.includes('rank')) {
            await db.exec("ALTER TABLE enseignants ADD COLUMN rank TEXT DEFAULT 'معلم';");
        }
        if (!columnNames.includes('weekly_load')) {
            await db.exec("ALTER TABLE enseignants ADD COLUMN weekly_load INTEGER DEFAULT 0;");
        }

        // 3. إدراج بيانات تجريبية للطلاب (إدراج فقط إذا كان الجدول فارغاً)
        const count = await db.get("SELECT COUNT(*) as total FROM eleves");
        if (count.total === 0) {
            await db.run("INSERT INTO eleves (nom, classe, section) VALUES ('أحمد خليفة راشد الخروصي', '5', '2')");
            await db.run("INSERT INTO eleves (nom, classe, section) VALUES ('أمجد سعيد احمد القنوبي', '5', '2')");
            await db.run("INSERT INTO eleves (nom, classe, section) VALUES ('بسام ياسر محمد الرئيسي', '5', '2')");
            console.log("📥 تم إدراج بيانات الطلاب التجريبية.");
        }

        console.log("✅ قاعدة البيانات جاهزة ومحدثة بسياسة الاحتياط (إداري، رتبة، عبء أسبوعي).");
    } catch (err) {
        console.error("❌ حدث خطأ أثناء التهيئة:", err);
    }
}

setup();