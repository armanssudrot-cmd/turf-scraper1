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
        'Accept': 'application/json, */*',
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

function nom(obj) {
  if (!obj) return '';
  return obj.nom || obj.name || obj.libelle || obj.libelleCourt || '';
}

// ── API PMU ──────────────────────────────────────────────────
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
      if (res.status !== 200) { console.log('[PMU] Status:', res.status); continue; }
      
      const data = JSON.parse(res.body);
      if (!data.participants || data.participants.length === 0) continue;

      console.log('[PMU] Sample partant:', JSON.stringify(data.participants[0]).substring(0, 300));

      return {
        source: 'pmu_api',
        course: {
          nom: data.libelle || data.libelleCourt || '',
          hippodrome: nom(data.hippodrome),
          heure: data.heureDepart ? new Date(data.heureDepart).toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'}) : '',
          distance: data.distanceUnit ? data.distanceUnit + 'm' : (data.distance ? data.distance + 'm' : ''),
          discipline: data.specialite || data.discipline || '',
          terrain: nom(data.terrain) || data.parcours || '',
          partants_total: data.participants.length,
          dotation: data.montantPrix ? (data.montantPrix / 100) + 'e' : ''
        },
        partants: data.participants.map(p => {
          // Driver/Jockey - peut être un objet ou une string
          let driverNom = '';
          if (p.driver) driverNom = typeof p.driver === 'string' ? p.driver : nom(p.driver);
          else if (p.jockey) driverNom = typeof p.jockey === 'string' ? p.jockey : nom(p.jockey);
          else if (p.driverName) driverNom = p.driverName;
          else if (p.jockeyName) driverNom = p.jockeyName;

          // Entraineur
          let entraineurNom = '';
          if (p.entraineur) entraineurNom = typeof p.entraineur === 'string' ? p.entraineur : nom(p.entraineur);
          else if (p.trainer) entraineurNom = typeof p.trainer === 'string' ? p.trainer : nom(p.trainer);
          else if (p.entraineurName) entraineurNom = p.entraineurName;

          // Gains - peut être dans gainsParticipant ou directement
          let gains = 0;
          if (p.gainsParticipant) {
            gains = (p.gainsParticipant.gainsCarriere || p.gainsParticipant.gainsTotaux || 0) / 100;
          } else {
            gains = p.gainsCarriere || p.gainsVictoires || p.gains || 0;
            if (gains > 1000000) gains = gains / 100; // Parfois en centimes
          }

          // Musique
          let musique = p.musique || p.formString || p.dernierRapport || '';

          // Cote
          let cote = '';
          if (p.rapportSimpleGagnant) cote = String(p.rapportSimpleGagnant);
          else if (p.dernierRapportDirect) cote = String(p.dernierRapportDirect);
          else if (p.cote) cote = String(p.cote);

          return {
            num: String(p.numPmu || p.numero || ''),
            nom: p.nom || '',
            driver: driverNom,
            entraineur: entraineurNom,
            cote: cote,
            musique: musique,
            gains_total: Math.round(gains),
            nb_courses: p.nombreCourses || p.nbCourses || 0,
            poids: p.poidsJockey || p.poids || 0,
            deferre: p.deferre || '',
            oeilleres: p.oeilleres || '',
            proprietaire: nom(p.proprietaire)
          };
        }).filter(p => p.nom)
      };
    } catch(e) {
      console.log('[PMU] Erreur:', e.message);
    }
  }
  return null;
}

// ── API Geny (AJAX) ──────────────────────────────────────────
async function getGeny(date, nomCourse, hippodrome, courseId) {
  function slug(s) {
    return (s||'').toLowerCase().normalize('NFD')
      .replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
  }

  // Essayer l'URL avec ID Geny si disponible
  const urls = [];
  if (courseId) urls.push(`https://www.geny.com/partants-pmu/${date}-${slug(hippodrome)}-pmu-${slug(nomCourse)}_c${courseId}`);
  urls.push(`https://www.geny.com/partants-pmu/${date}-${slug(hippodrome)}-pmu-${slug(nomCourse)}`);

  for (const url of urls) {
    try {
      console.log('[Geny HTML]', url);
      const res = await httpGet(url, { 'Accept': 'text/html' });
      if (res.status !== 200) continue;

      // Chercher les données JSON dans le HTML
      const html = res.body;
      
      // Pattern 1: variable JS avec les partants
      const patterns = [
        /var\s+partants\s*=\s*(\[[\s\S]{50,}\]);/,
        /"partants"\s*:\s*(\[[\s\S]{50,}\])/,
        /partants\s*:\s*(\[[\s\S]{50,}\])/,
        /runners\s*:\s*(\[[\s\S]{50,}\])/,
        /"participants"\s*:\s*(\[[\s\S]{50,}\])/
      ];

      for (const pat of patterns) {
        const m = html.match(pat);
        if (m) {
          try {
            const arr = JSON.parse(m[1]);
            if (arr.length > 2) {
              console.log('[Geny] Données trouvées:', arr.length, 'partants');
              return {
                source: 'geny',
                course: { nom: nomCourse, hippodrome },
                partants: arr.map((p,i) => ({
                  num: String(p.numero || p.num || i+1),
                  nom: p.nom || p.cheval || p.horseName || '',
                  driver: p.driver || p.jockey || '',
                  entraineur: p.entraineur || p.trainer || '',
                  cote: String(p.cote || p.rapport || ''),
                  musique: p.musique || '',
                  gains_total: p.gainsCarriere || p.gains || 0,
                  nb_courses: p.nbCourses || 0
                })).filter(p => p.nom)
              };
            }
          } catch(e) {}
        }
      }
    } catch(e) {
      console.log('[Geny] Erreur:', e.message);
    }
  }
  return null;
}

// ── FUSION ───────────────────────────────────────────────────
function fusionner(pmu, geny) {
  if (!pmu) return geny;
  if (!geny || geny.partants.length === 0) return pmu;

  // Enrichir PMU avec données Geny
  pmu.partants = pmu.partants.map(p => {
    const g = geny.partants.find(e =>
      e.num === p.num || e.nom.toLowerCase() === p.nom.toLowerCase()
    );
    if (!g) return p;
    return {
      ...p,
      driver: p.driver || g.driver || '',
      entraineur: p.entraineur || g.entraineur || '',
      cote: g.cote || p.cote || '',
      musique: p.musique || g.musique || '',
      gains_total: p.gains_total || g.gains_total || 0
    };
  });

  pmu.source = 'pmu_api+geny';
  return pmu;
}

// ── ROUTES ───────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Turf Scraper API', version: '5.0.0' });
});

app.post('/partants', async (req, res) => {
  const { date, nomCourse, hippodrome, reunion, numCourse, courseId } = req.body;

  if (!date || !reunion || !numCourse) {
    return res.status(400).json({ error: 'date, reunion et numCourse requis', recu: req.body });
  }

  console.log(`\n[API] ${date} ${reunion}/${numCourse} "${nomCourse}" ${hippodrome}`);

  // PMU en priorité + Geny en parallèle
  const [pmuResult, genyResult] = await Promise.allSettled([
    getPMU(date, reunion, numCourse),
    nomCourse && hippodrome ? getGeny(date, nomCourse, hippodrome, courseId) : Promise.resolve(null)
  ]).then(r => r.map(x => x.status === 'fulfilled' ? x.value : null));

  console.log(`[API] PMU: ${pmuResult?.partants?.length||0} | Geny: ${genyResult?.partants?.length||0}`);

  const final = fusionner(pmuResult, genyResult);

  if (final && final.partants && final.partants.length > 0) {
    console.log(`[API] OK (${final.source}): ${final.partants.length} partants`);
    // Log premier partant pour debug
    if (final.partants[0]) console.log('[API] Partant 1:', JSON.stringify(final.partants[0]));
    return res.json({ ...final, date, demande: { nomCourse, hippodrome, reunion, numCourse } });
  }

  res.status(404).json({
    partants: [], date,
    demande: { nomCourse, hippodrome, reunion, numCourse },
    message: 'Partants non trouves - Claude va chercher'
  });
});

app.listen(PORT, () => console.log(`Turf Scraper v5.0 - Port ${PORT}`));
