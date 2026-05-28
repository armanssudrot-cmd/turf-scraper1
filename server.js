const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

const https = require('https');
const http = require('http');

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/html, */*',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        'Cache-Control': 'no-cache'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function dateToPMU(date) {
  const p = date.split('-');
  return p[2] + p[1] + p[0];
}

// Source 1: API PMU officielle
async function getPMUApi(date, reunion, numCourse) {
  const datePMU = dateToPMU(date);
  const url = `https://online.turfinfo.api.pmu.fr/rest/client/7/programme/${datePMU}/${reunion}/${numCourse}/participants?specialisation=INTERNET`;
  console.log('[PMU]', url);
  
  try {
    const res = await httpGet(url);
    if (res.status !== 200) return null;
    const data = JSON.parse(res.body);
    if (!data.participants || data.participants.length === 0) return null;
    
    return {
      source: 'pmu_api',
      course: {
        nom: data.libelle || '',
        hippodrome: data.hippodrome?.libelleCourt || data.hippodrome?.libelleLong || '',
        heure: data.heureDepart ? new Date(data.heureDepart).toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'}) : '',
        distance: data.distanceUnit ? data.distanceUnit + 'm' : (data.distance ? data.distance + 'm' : ''),
        discipline: data.specialite || '',
        terrain: data.terrain?.libelle || '',
        partants_total: data.participants.length,
        dotation: data.montantPrix ? data.montantPrix + 'e' : ''
      },
      partants: data.participants.map(p => ({
        num: String(p.numPmu || ''),
        nom: p.nom || '',
        driver: p.driver?.nom || p.jockey?.nom || '',
        entraineur: p.entraineur?.nom || '',
        cote: p.rapportSimpleGagnant ? String(p.rapportSimpleGagnant) : '',
        musique: p.musique || '',
        gains_total: p.gainsCarriere || 0,
        nb_courses: p.nombreCourses || 0
      })).filter(p => p.nom)
    };
  } catch(e) {
    console.log('[PMU] Erreur:', e.message);
    return null;
  }
}

// Source 2: API PMU offline (backup)
async function getPMUOffline(date, reunion, numCourse) {
  const datePMU = dateToPMU(date);
  const url = `https://offline.turfinfo.api.pmu.fr/rest/client/7/programme/${datePMU}/${reunion}/${numCourse}/participants`;
  console.log('[PMU-offline]', url);
  
  try {
    const res = await httpGet(url);
    if (res.status !== 200) return null;
    const data = JSON.parse(res.body);
    if (!data.participants || data.participants.length === 0) return null;
    
    return {
      source: 'pmu_offline',
      course: {
        nom: data.libelle || '',
        hippodrome: data.hippodrome?.libelleCourt || '',
        heure: '',
        distance: data.distanceUnit ? data.distanceUnit + 'm' : '',
        discipline: data.specialite || '',
        terrain: '',
        partants_total: data.participants.length,
        dotation: ''
      },
      partants: data.participants.map(p => ({
        num: String(p.numPmu || ''),
        nom: p.nom || '',
        driver: p.driver?.nom || p.jockey?.nom || '',
        entraineur: p.entraineur?.nom || '',
        cote: '',
        musique: p.musique || '',
        gains_total: p.gainsCarriere || 0,
        nb_courses: p.nombreCourses || 0
      })).filter(p => p.nom)
    };
  } catch(e) {
    console.log('[PMU-offline] Erreur:', e.message);
    return null;
  }
}

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Turf Scraper API', version: '3.0.0' });
});

// Route principale
app.post('/partants', async (req, res) => {
  const { date, nomCourse, hippodrome, reunion, numCourse } = req.body;
  if (!date || !reunion || !numCourse) {
    return res.status(400).json({ 
      error: 'date, reunion et numCourse requis',
      recu: { date, reunion, numCourse }
    });
  }

  console.log(`\n[API] ${date} ${reunion}/${numCourse} "${nomCourse}" ${hippodrome}`);

  // Essai 1: API PMU online
  let data = await getPMUApi(date, reunion, numCourse);
  if (data && data.partants.length > 0) {
    console.log(`[API] OK pmu_api: ${data.partants.length} partants - "${data.course.nom}"`);
    return res.json({ ...data, date, demande: { nomCourse, hippodrome, reunion, numCourse } });
  }

  // Essai 2: API PMU offline
  data = await getPMUOffline(date, reunion, numCourse);
  if (data && data.partants.length > 0) {
    console.log(`[API] OK pmu_offline: ${data.partants.length} partants`);
    return res.json({ ...data, date, demande: { nomCourse, hippodrome, reunion, numCourse } });
  }

  console.log('[API] Aucune source OK');
  res.status(404).json({
    partants: [], date,
    demande: { nomCourse, hippodrome, reunion, numCourse },
    message: 'Partants non trouves via API PMU - Claude va chercher'
  });
});

app.listen(PORT, () => {
  console.log(`Turf Scraper v3.0 - Port ${PORT}`);
});
