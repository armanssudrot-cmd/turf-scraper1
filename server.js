const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 8080;
app.use(cors());
app.use(express.json());

function httpGet(url, extraHeaders={}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
        'Accept': 'application/json, text/html, */*',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        'Cache-Control': 'no-cache',
        ...extraHeaders
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location, extraHeaders).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
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

function nomObj(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  return obj.nom || obj.name || obj.libelle || obj.libelleCourt || '';
}

// ── API PMU participants ─────────────────────────────────────
async function getPMU(date, reunion, numCourse) {
  const d = dateToPMU(date);
  const urls = [
    `https://online.turfinfo.api.pmu.fr/rest/client/7/programme/${d}/${reunion}/${numCourse}/participants?specialisation=INTERNET`,
    `https://offline.turfinfo.api.pmu.fr/rest/client/7/programme/${d}/${reunion}/${numCourse}/participants`
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
          nom: data.libelle || data.libelleCourt || '',
          hippodrome: nomObj(data.hippodrome),
          heure: data.heureDepart ? new Date(data.heureDepart).toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'}) : '',
          distance: data.distanceUnit ? data.distanceUnit+'m' : '',
          discipline: data.specialite || '',
          terrain: nomObj(data.terrain) || data.parcours || '',
          partants_total: data.participants.length,
          dotation: data.montantPrix ? Math.round(data.montantPrix/100)+'e' : ''
        },
        partants: data.participants.map(p => {
          let driver = nomObj(p.driver) || nomObj(p.jockey) || p.driverName || p.jockeyName || '';
          let entraineur = nomObj(p.entraineur) || nomObj(p.trainer) || p.entraineurName || '';
          let gains = 0;
          if (p.gainsParticipant) {
            gains = Math.round((p.gainsParticipant.gainsCarriere || p.gainsParticipant.gainsTotaux || 0) / 100);
          } else {
            gains = p.gainsCarriere || p.gainsVictoires || 0;
            if (gains > 100000) gains = Math.round(gains / 100);
          }
          // Cotes: rapportSimpleGagnant disponible seulement quand paris ouverts
          let cote = '';
          if (p.rapportSimpleGagnant && p.rapportSimpleGagnant > 0) cote = String(p.rapportSimpleGagnant);
          else if (p.dernierRapportDirect && p.dernierRapportDirect > 0) cote = String(p.dernierRapportDirect);
          else if (p.cote && p.cote > 0) cote = String(p.cote);

          return {
            num: String(p.numPmu || ''),
            nom: p.nom || '',
            driver,
            entraineur,
            cote,
            musique: p.musique || '',
            gains_total: gains,
            nb_courses: p.nombreCourses || 0,
            poids: p.poidsJockey || 0,
            deferre: p.deferre || '',
            oeilleres: p.oeilleres || '',
            proprietaire: nomObj(p.proprietaire)
          };
        }).filter(p => p.nom)
      };
    } catch(e) {
      console.log('[PMU] Erreur:', e.message);
    }
  }
  return null;
}

// ── Cotes Zeturf ────────────────────────────────────────────
async function getCotesZeturf(date, reunion, numCourse) {
  // Zeturf expose les cotes dans ses pages de course
  const url = `https://www.zeturf.fr/fr/course-du-jour/${date}/${reunion.toLowerCase()}${numCourse.toLowerCase()}-`;
  try {
    console.log('[Zeturf cotes]', url);
    const res = await httpGet(url);
    if (res.status !== 200) return null;
    
    // Chercher les cotes dans le JSON embarqué
    const html = res.body;
    const match = html.match(/"odds":\s*(\{[^}]+\})/);
    if (match) {
      const odds = JSON.parse(match[1]);
      return odds;
    }
    
    // Chercher pattern alternatif
    const patterns = [
      /"cote"\s*:\s*([\d.]+)/g,
      /"rapport"\s*:\s*([\d.]+)/g,
      /data-cote="([\d.]+)"/g
    ];
    const cotes = {};
    for (const pat of patterns) {
      let m;
      let num = 1;
      while ((m = pat.exec(html)) !== null) {
        cotes[num++] = m[1];
      }
      if (Object.keys(cotes).length > 2) return cotes;
    }
  } catch(e) {
    console.log('[Zeturf] Erreur:', e.message);
  }
  return null;
}

// ── Cotes PMU endpoint dédié ─────────────────────────────────
async function getCotesPMU(date, reunion, numCourse) {
  const d = dateToPMU(date);
  // Endpoints spécifiques pour les cotes en direct
  const urls = [
    `https://online.turfinfo.api.pmu.fr/rest/client/7/programme/${d}/${reunion}/${numCourse}/rapports-complets`,
    `https://online.turfinfo.api.pmu.fr/rest/client/7/programme/${d}/${reunion}/${numCourse}/rapports-definitifs`,
    `https://www.pmu.fr/rest/client/7/programme/${d}/${reunion}/${numCourse}/rapports-complets`
  ];

  for (const url of urls) {
    try {
      console.log('[PMU cotes]', url);
      const res = await httpGet(url);
      if (res.status !== 200) continue;
      const data = JSON.parse(res.body);
      
      // Chercher les rapports simples gagnants
      const rapports = data.rapportsSimples || data.rapports || data.listeRapports || [];
      if (rapports.length > 0) {
        const cotesMap = {};
        rapports.forEach(r => {
          if (r.numPmu && r.rapport) cotesMap[String(r.numPmu)] = String(r.rapport);
          else if (r.combinaison && r.combinaison.length === 1 && r.rapport) {
            cotesMap[String(r.combinaison[0])] = String(r.rapport);
          }
        });
        if (Object.keys(cotesMap).length > 0) {
          console.log('[PMU cotes] Trouvé:', Object.keys(cotesMap).length, 'cotes');
          return cotesMap;
        }
      }
    } catch(e) {
      console.log('[PMU cotes] Erreur:', e.message);
    }
  }
  return null;
}

// ── Fusion avec cotes ────────────────────────────────────────
function enrichirCotes(partants, cotesMap) {
  if (!cotesMap || Object.keys(cotesMap).length === 0) return partants;
  return partants.map(p => ({
    ...p,
    cote: cotesMap[p.num] || p.cote || ''
  }));
}

// ── ROUTES ───────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Turf Scraper API', version: '6.0.0' });
});

app.post('/partants', async (req, res) => {
  const { date, nomCourse, hippodrome, reunion, numCourse, courseId } = req.body;
  if (!date || !reunion || !numCourse) {
    return res.status(400).json({ error: 'date, reunion et numCourse requis', recu: req.body });
  }

  console.log(`\n[API] ${date} ${reunion}/${numCourse} "${nomCourse}" ${hippodrome}`);

  // Lancer PMU + cotes en parallèle
  const [pmuResult, cotesResult] = await Promise.allSettled([
    getPMU(date, reunion, numCourse),
    getCotesPMU(date, reunion, numCourse)
  ]).then(r => r.map(x => x.status === 'fulfilled' ? x.value : null));

  console.log(`[API] PMU: ${pmuResult?.partants?.length||0} partants | Cotes: ${cotesResult ? Object.keys(cotesResult).length : 0}`);

  if (!pmuResult || pmuResult.partants.length === 0) {
    return res.status(404).json({
      partants: [], date,
      demande: { nomCourse, hippodrome, reunion, numCourse },
      message: 'Partants non trouves - Claude va chercher'
    });
  }

  // Enrichir avec les cotes si disponibles
  if (cotesResult) {
    pmuResult.partants = enrichirCotes(pmuResult.partants, cotesResult);
    pmuResult.source = 'pmu_api+cotes';
  }

  // Log premier partant pour debug
  console.log('[API] Partant 1:', JSON.stringify(pmuResult.partants[0]));

  return res.json({
    ...pmuResult,
    date,
    demande: { nomCourse, hippodrome, reunion, numCourse }
  });
});

app.listen(PORT, () => console.log(`Turf Scraper v6.0 - Port ${PORT}`));
