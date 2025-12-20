const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

async function setup() {
    try {
        const db = await open({
            filename: './ecole_ibn_durid.db',
            driver: sqlite3.Database
        });

        // Création de la table des élèves pour l'école Ibn Durid
        await db.exec(`CREATE TABLE IF NOT EXISTS eleves (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nom TEXT,
            classe TEXT,
            section TEXT
        )`);

        // Insertion des données réelles issues de vos documents
        await db.run("INSERT INTO eleves (nom, classe, section) VALUES ('أحمد خليفة راشد الخروصي', '5', '2')");
        await db.run("INSERT INTO eleves (nom, classe, section) VALUES ('أمجد سعيد احمد القنوبي', '5', '2')");
        await db.run("INSERT INTO eleves (nom, classe, section) VALUES ('بسام ياسر محمد الرئيسي', '5', '2')");
await db.exec(`
    CREATE TABLE IF NOT EXISTS enseignants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nom TEXT,
        matiere TEXT,
        phone_number TEXT
    );

    CREATE TABLE IF NOT EXISTS affectations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        enseignant_id INTEGER,
        classe TEXT,
        section TEXT,
        FOREIGN KEY(enseignant_id) REFERENCES enseignants(id)
    );
`);



        console.log("✅ Base de données initialisée avec succès !");
    } catch (err) {
        console.error("❌ Erreur lors de l'initialisation :", err);
    }
}

setup();