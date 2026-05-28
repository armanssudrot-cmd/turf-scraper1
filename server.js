const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 8080;
app.use(cors());
app.use(express.json());

function httpGet(url, headers={}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
        'Accept': 'application/json, text/html, */*',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        'Cache-Control': 'no-cache',
        ...headers
      }
    };
    const req = lib.get(url, opts, (res) => {
      // Suivre les redirections
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location, headers).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function dateToPMU(date) {
  const p = date.split('-');
  return p[2] + p[1] + p[0];
}

// ── SOURCE 1: API PMU officielle ─────────────────────────────
async function getPMU(date, reunion, numCourse) {
  const datePMU = dateToPMU(date);
  const urls = [
    `https://online.turfinfo.api.pmu.fr/rest/client/7/programme/${datePMU}/${reunion}/${numCourse}/participants?specialisation=INTERNET`,
    `https://offline.turfinfo.api.pmu.fr/rest/client/7/programme/${datePMU}/${reunion}/${numCourse}/participants`
  ];

  for (const url of urls) {
    try {
      console.log('[PMU]', url);
      const res = await httpGet(url);
      if (res.status !== 200) continue;
      const data = JSON.parse(res.body);
      if (!data.participants || data.participants.length === 0) continue;

      return {
        source: 'pmu_api',
        course: {
          nom: data.libelle || '',
          hippodrome: data.hippodrome?.libelleCourt || data.hippodrome?.libelleLong || '',
          heure: data.heureDepart ? new Date(data.heureDepart).toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'}) : '',
          distance: data.distanceUnit ? data.distanceUnit+'m' : '',
          discipline: data.specialite || '',
          terrain: data.terrain?.libelle || '',
          partants_total: data.participants.length,
          dotation: data.montantPrix ? data.montantPrix+'e' : ''
        },
        partants: data.participants.map(p => ({
          num: String(p.numPmu || ''),
          nom: p.nom || '',
          driver: p.driver?.nom || p.jockey?.nom || '',
          entraineur: p.entraineur?.nom || '',
          cote: p.rapportSimpleGagnant ? String(p.rapportSimpleGagnant) : '',
          musique: p.musique || '',
          gains_total: p.gainsCarriere || p.gainsVictoires || 0,
          nb_courses: p.nombreCourses || 0,
          poids: p.poidsJockey || 0,
          proprietaire: p.proprietaire?.nom || ''
        })).filter(p => p.nom)
      };
    } catch(e) {
      console.log('[PMU] Erreur:', e.message);
    }
  }
  return null;
}

// ── SOURCE 2: API Equidia ─────────────────────────────────────
async function getEquidia(date, reunion, numCourse) {
  // Equidia a une API interne accessible
  const urls = [
    `https://www.equidia.fr/api/courses/${date}/${reunion}/${numCourse}/runners`,
    `https://www.equidia.fr/api/programme/${date}/${reunion}/${numCourse}`,
    `https://www.equidia.fr/courses/${date}/${reunion}/${numCourse}`
  ];

  for (const url of urls) {
    try {
      console.log('[Equidia]', url);
      const res = await httpGet(url, { 'Accept': 'application/json' });
      if (res.status !== 200) continue;

      let data;
      try { data = JSON.parse(res.body); } catch(e) { continue; }

      // Chercher les runners dans différents formats
      const runners = data.runners || data.participants || data.partants ||
                     data.race?.runners || data.course?.participants || [];

      if (runners.length > 0) {
        return {
          source: 'equidia',
          course: {
            nom: data.name || data.nom || data.race?.name || '',
            hippodrome: data.racecourse?.name || data.hippodrome?.nom || '',
            heure: data.startTime || data.heureDepart || '',
            distance: data.distance ? data.distance+'m' : '',
            discipline: data.discipline || data.specialite || '',
            terrain: data.going || data.terrain || '',
            partants_total: runners.length,
            dotation: data.prize ? data.prize+'e' : ''
          },
          partants: runners.map(p => ({
            num: String(p.number || p.numero || p.saddleCloth || ''),
            nom: p.horseName || p.horse?.name || p.nom || '',
            driver: p.driverName || p.jockeyName || p.driver?.name || p.jockey?.name || '',
            entraineur: p.trainerName || p.trainer?.name || p.entraineur?.nom || '',
            cote: String(p.odds || p.cote || ''),
            musique: p.form || p.musique || p.music || '',
            gains_total: p.totalPrize || p.gainsCarriere || 0,
            nb_courses: p.starts || p.nbCourses || 0,
            poids: p.weight || p.poids || 0
          })).filter(p => p.nom)
        };
      }
    } catch(e) {
      console.log('[Equidia] Erreur:', e.message);
    }
  }
  return null;
}

// ── SOURCE 3: Geny API ────────────────────────────────────────
async function getGeny(date, nomCourse, hippodrome) {
  function slugify(s) {
    return (s||'').toLowerCase().normalize('NFD')
      .replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
  }

  const url = `https://www.geny.com/ajax/ajax_partants.php?date=${date}&hippodrome=${slugify(hippodrome)}&course=${slugify(nomCourse)}`;

  try {
    console.log('[Geny]', url);
    const res = await httpGet(url, {
      'Referer': 'https://www.geny.com',
      'X-Requested-With': 'XMLHttpRequest'
    });
    if (res.status !== 200) return null;
    const data = JSON.parse(res.body);
    const partants = data.partants || data.chevaux || data.runners || [];
    if (partants.length === 0) return null;

    return {
      source: 'geny',
      course: { nom: data.libelle || nomCourse, hippodrome },
      partants: partants.map(p => ({
        num: String(p.numero || p.num || ''),
        nom: p.nom || p.cheval || '',
        driver: p.driver || p.jockey || '',
        entraineur: p.entraineur || p.trainer || '',
        cote: String(p.cote || p.rapport || ''),
        musique: p.musique || '',
        gains_total: p.gainsCarriere || p.gains || 0,
        nb_courses: p.nbCourses || 0
      })).filter(p => p.nom)
    };
  } catch(e) {
    console.log('[Geny] Erreur:', e.message);
    return null;
  }
}

// ── FUSION des données ────────────────────────────────────────
function fusionner(pmu, equidia, geny) {
  // Prendre PMU comme base (meilleure source pour musique/gains)
  // Enrichir avec Equidia (meilleure source pour entraineur/driver/cote)
  if (!pmu) return equidia || geny;

  const base = pmu;

  if (equidia && equidia.partants.length > 0) {
    base.partants = base.partants.map(p => {
      // Trouver le partant correspondant dans Equidia par numéro ou nom
      const eq = equidia.partants.find(e =>
        e.num === p.num || e.nom.toLowerCase() === p.nom.toLowerCase()
      );
      if (!eq) return p;
      return {
        ...p,
        driver: p.driver || eq.driver || '',
        entraineur: p.entraineur || eq.entraineur || '',
        cote: eq.cote || p.cote || '',
        gains_total: p.gains_total || eq.gains_total || 0,
        nb_courses: p.nb_courses || eq.nb_courses || 0,
        poids: p.poids || eq.poids || 0
      };
    });
    // Enrichir les infos course avec Equidia
    if (!base.course.terrain && equidia.course.terrain) base.course.terrain = equidia.course.terrain;
    if (!base.course.heure && equidia.course.heure) base.course.heure = equidia.course.heure;
    base.source = 'pmu_api+equidia';
  }

  if (geny && geny.partants.length > 0) {
    base.partants = base.partants.map(p => {
      const g = geny.partants.find(e =>
        e.num === p.num || e.nom.toLowerCase() === p.nom.toLowerCase()
      );
      if (!g) return p;
      return {
        ...p,
        driver: p.driver || g.driver || '',
        entraineur: p.entraineur || g.entraineur || '',
        cote: p.cote || g.cote || '',
        musique: p.musique || g.musique || ''
      };
    });
  }

  return base;
}

// ── ROUTES ────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Turf Scraper API', version: '4.0.0' });
});

app.post('/partants', async (req, res) => {
  const { date, nomCourse, hippodrome, reunion, numCourse } = req.body;
  if (!date || !reunion || !numCourse) {
    return res.status(400).json({ error: 'date, reunion et numCourse requis' });
  }

  console.log(`\n[API] ${date} ${reunion}/${numCourse} "${nomCourse}" ${hippodrome}`);

  // Lancer les 3 sources en parallele
  const [pmu, equidia, geny] = await Promise.allSettled([
    getPMU(date, reunion, numCourse),
    getEquidia(date, reunion, numCourse),
    nomCourse && hippodrome ? getGeny(date, nomCourse, hippodrome) : Promise.resolve(null)
  ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : null));

  console.log(`[API] PMU: ${pmu?.partants?.length||0} | Equidia: ${equidia?.partants?.length||0} | Geny: ${geny?.partants?.length||0}`);

  // Fusionner les résultats
  const fusionne = fusionner(pmu, equidia, geny);

  if (fusionne && fusionne.partants && fusionne.partants.length > 0) {
    console.log(`[API] OK: ${fusionne.partants.length} partants (${fusionne.source})`);
    return res.json({ ...fusionne, date, demande: { nomCourse, hippodrome, reunion, numCourse } });
  }

  res.status(404).json({
    partants: [], date,
    demande: { nomCourse, hippodrome, reunion, numCourse },
    message: 'Partants non trouves - Claude va chercher'
  });
});

app.listen(PORT, () => {
  console.log(`Turf Scraper v4.0 - Port ${PORT}`);
});
