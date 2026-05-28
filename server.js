const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// ── UTILITAIRES ──────────────────────────────────────────────

function slugify(str) {
  return (str || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function dateToGeny(date) {
  // YYYY-MM-DD -> YYYY-MM-DD (deja bon)
  return date;
}

function dateToPMU(date) {
  // YYYY-MM-DD -> DDMMYYYY
  const p = date.split('-');
  return p[2] + p[1] + p[0];
}

async function getBrowser() {
  return await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', '--disable-gpu',
      '--no-first-run', '--no-zygote',
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor'
    ]
  });
}

// ── SCRAPER PMU API (source principale) ─────────────────────

async function scraperPMUApi(date, reunion, numCourse) {
  const datePMU = dateToPMU(date);
  const url = `https://online.turfinfo.api.pmu.fr/rest/client/7/programme/${datePMU}/${reunion}/${numCourse}/participants?specialisation=INTERNET`;
  
  console.log(`[PMU] ${url}`);
  
  const browser = await getBrowser();
  const page = await browser.newPage();
  
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    
    const content = await page.evaluate(() => document.body.innerText);
    await browser.close();
    
    const data = JSON.parse(content);
    
    if (!data.participants || data.participants.length === 0) return null;
    
    return {
      source: 'pmu_api',
      course: {
        nom: data.libelle || '',
        hippodrome: data.hippodrome?.libelleCourt || data.hippodrome?.libelleLong || '',
        heure: data.heureDepart ? new Date(data.heureDepart).toLocaleTimeString('fr-FR', {hour:'2-digit', minute:'2-digit'}) : '',
        distance: data.distance ? data.distance + 'm' : '',
        discipline: data.specialite || '',
        terrain: data.terrain?.libelle || '',
        partants_total: data.participants.length,
        dotation: data.montantPrix ? data.montantPrix + 'e' : ''
      },
      partants: data.participants.map(p => ({
        num: String(p.numPmu || p.numero || ''),
        nom: p.nom || '',
        driver: p.driver?.nom || p.jockey?.nom || '',
        entraineur: p.entraineur?.nom || '',
        cote: p.rapportSimpleGagnant ? String(p.rapportSimpleGagnant) : '',
        musique: p.musique || p.formString || '',
        gains_total: p.gainsCarriere || p.gainsVictoires || 0,
        nb_courses: p.nombreCourses || p.nbCourses || 0,
        poids: p.poidsJockey || p.poids || 0,
        deferre: p.deferre || '',
        oeilleres: p.oeilleres || ''
      }))
    };
  } catch(err) {
    await browser.close();
    console.log(`[PMU] Erreur: ${err.message}`);
    return null;
  }
}

// ── SCRAPER GENY (interception réseau) ──────────────────────

async function scraperGeny(date, nomCourse, hippodrome, courseId) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  let partantsData = null;

  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120');
    
    // Intercepter les réponses réseau pour capturer les appels API internes
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('partant') || url.includes('cheval') || url.includes('runner') || 
          url.includes('participant') || (url.includes('geny.com') && url.includes('api'))) {
        try {
          const ct = response.headers()['content-type'] || '';
          if (ct.includes('json')) {
            const json = await response.json();
            if (json && (json.partants || json.participants || json.runners || json.chevaux)) {
              partantsData = json;
              console.log(`[Geny] Données interceptées depuis: ${url}`);
            }
          }
        } catch(e) {}
      }
    });

    // Construire l'URL Geny
    let url;
    if (courseId) {
      url = `https://www.geny.com/partants-pmu/${date}-${slugify(hippodrome)}-pmu-${slugify(nomCourse)}_c${courseId}`;
    } else {
      url = `https://www.geny.com/partants-pmu/${date}-${slugify(hippodrome)}-pmu-${slugify(nomCourse)}`;
    }
    
    console.log(`[Geny] ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    if (partantsData) {
      const raw = partantsData.partants || partantsData.participants || partantsData.runners || partantsData.chevaux || [];
      await browser.close();
      return {
        source: 'geny',
        course: { nom: nomCourse, hippodrome },
        partants: raw.map((p, i) => ({
          num: String(p.numero || p.num || p.numPmu || i+1),
          nom: p.nom || p.name || p.libelle || '',
          driver: p.driver || p.jockey || p.driverName || '',
          entraineur: p.entraineur || p.trainer || '',
          cote: String(p.cote || p.odds || p.rapport || ''),
          musique: p.musique || p.music || p.formString || '',
          gains_total: p.gainsCarriere || p.gains || p.totalGains || 0,
          nb_courses: p.nbCourses || p.nombreCourses || 0
        })).filter(p => p.nom && p.nom.length > 1)
      };
    }

    // Fallback: lire le HTML rendu
    const extracted = await page.evaluate(() => {
      const result = { partants: [], course: {} };
      
      // Titre de la course
      const h1 = document.querySelector('h1, .titre-course, .libelle-course');
      if (h1) result.course.nom = h1.textContent.trim();
      
      // Chercher dans tous les scripts le JSON des partants
      for (const script of document.querySelectorAll('script')) {
        const src = script.textContent;
        const patterns = [
          /partants\s*[=:]\s*(\[[\s\S]{50,}\])/,
          /chevaux\s*[=:]\s*(\[[\s\S]{50,}\])/,
          /"participants"\s*:\s*(\[[\s\S]{50,}\])/,
          /window\.\w+\s*=\s*(\{[\s\S]{100,}\})/
        ];
        for (const pat of patterns) {
          const m = src.match(pat);
          if (m) {
            try {
              const d = JSON.parse(m[1]);
              const arr = Array.isArray(d) ? d : (d.partants || d.participants || d.chevaux || []);
              if (arr.length > 2) {
                result.partants = arr.map((p, i) => ({
                  num: String(p.numero || p.num || i+1),
                  nom: p.nom || p.name || p.libelle || '',
                  driver: p.driver || p.jockey || '',
                  entraineur: p.entraineur || p.trainer || '',
                  cote: String(p.cote || p.rapport || ''),
                  musique: p.musique || p.formString || '',
                  gains_total: p.gainsCarriere || p.gains || 0,
                  nb_courses: p.nbCourses || 0
                })).filter(p => p.nom && p.nom.length > 1);
                return result;
              }
            } catch(e) {}
          }
        }
      }
      
      // Lire le tableau HTML direct
      const rows = document.querySelectorAll('tr');
      rows.forEach(row => {
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length >= 3) {
          const num = cells[0]?.textContent?.trim();
          const nom = cells[1]?.textContent?.trim() || cells[2]?.textContent?.trim();
          if (num && nom && /^\d+$/.test(num) && nom.length > 2 && /[A-Z]/.test(nom)) {
            result.partants.push({
              num, nom,
              driver: cells[3]?.textContent?.trim() || '',
              entraineur: cells[4]?.textContent?.trim() || '',
              cote: cells[5]?.textContent?.trim() || '',
              musique: '', gains_total: 0, nb_courses: 0
            });
          }
        }
      });
      
      return result;
    });

    await browser.close();
    
    if (extracted.partants.length > 2) {
      return { source: 'geny_html', ...extracted };
    }
    return null;
    
  } catch(err) {
    await browser.close();
    console.log(`[Geny] Erreur: ${err.message}`);
    return null;
  }
}

// ── SCRAPER EQUIDIA ──────────────────────────────────────────

async function scraperEquidia(date, reunion, numCourse) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  let apiData = null;

  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120');
    
    // Intercepter les appels API Equidia
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('equidia') && (url.includes('runner') || url.includes('participant') || url.includes('course'))) {
        try {
          const ct = response.headers()['content-type'] || '';
          if (ct.includes('json')) {
            const json = await response.json();
            if (json && (json.runners || json.participants || json.partants)) {
              apiData = json;
              console.log(`[Equidia] API interceptée: ${url}`);
            }
          }
        } catch(e) {}
      }
    });

    const url = `https://www.equidia.fr/courses/${date}/${reunion}/${numCourse}`;
    console.log(`[Equidia] ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    if (apiData) {
      const raw = apiData.runners || apiData.participants || apiData.partants || [];
      await browser.close();
      return {
        source: 'equidia',
        course: {},
        partants: raw.map((p, i) => ({
          num: String(p.number || p.numero || i+1),
          nom: p.horseName || p.nom || p.name || '',
          driver: p.driverName || p.jockeyName || '',
          entraineur: p.trainerName || '',
          cote: String(p.odds || p.cote || ''),
          musique: p.music || p.musique || '',
          gains_total: p.totalGains || 0,
          nb_courses: p.totalRuns || 0
        })).filter(p => p.nom && p.nom.length > 1)
      };
    }

    // Fallback HTML Equidia
    const extracted = await page.evaluate(() => {
      const result = { partants: [], course: {} };
      
      // Next.js data
      const nextScript = document.getElementById('__NEXT_DATA__');
      if (nextScript) {
        try {
          const nd = JSON.parse(nextScript.textContent);
          const findRunners = (obj, depth = 0) => {
            if (depth > 5) return null;
            if (!obj || typeof obj !== 'object') return null;
            if (Array.isArray(obj) && obj.length > 2 && obj[0] && (obj[0].horseName || obj[0].nom || obj[0].number)) return obj;
            for (const key of Object.keys(obj)) {
              const found = findRunners(obj[key], depth + 1);
              if (found) return found;
            }
            return null;
          };
          const runners = findRunners(nd);
          if (runners) {
            result.partants = runners.map((p, i) => ({
              num: String(p.number || p.numero || i+1),
              nom: p.horseName || p.nom || p.name || '',
              driver: p.driverName || p.jockeyName || p.driver?.name || '',
              entraineur: p.trainerName || p.trainer?.name || '',
              cote: String(p.odds || p.cote || ''),
              musique: p.music || p.musique || '',
              gains_total: p.totalGains || 0,
              nb_courses: p.totalRuns || 0
            })).filter(p => p.nom && p.nom.length > 1);
          }
        } catch(e) {}
      }
      
      return result;
    });

    await browser.close();
    
    if (extracted.partants.length > 2) {
      return { source: 'equidia_html', ...extracted };
    }
    return null;

  } catch(err) {
    await browser.close();
    console.log(`[Equidia] Erreur: ${err.message}`);
    return null;
  }
}

// ── NORMALISER ───────────────────────────────────────────────

function verifierHippodrome(data, hippodrome) {
  if (!hippodrome || !data || !data.course) return true;
  const h1 = (data.course.hippodrome || '').toLowerCase().replace(/[-_]/g,' ').trim();
  const h2 = hippodrome.toLowerCase().replace(/[-_]/g,' ').trim();
  if (!h1) return true;
  return h1.includes(h2) || h2.includes(h1) || h1.split(' ')[0] === h2.split(' ')[0];
}

// ── ROUTES ───────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Turf Scraper API', version: '2.0.0' });
});

app.post('/partants', async (req, res) => {
  const { date, nomCourse, hippodrome, reunion, numCourse, courseId } = req.body;

  if (!date) return res.status(400).json({ error: 'date requise' });

  console.log(`\n[API] Requete: date=${date} nom="${nomCourse}" hippo="${hippodrome}" ${reunion}/${numCourse}`);

  const erreurs = [];

  // Essai 1: API PMU officielle (meilleure source - données completes)
  if (reunion && numCourse) {
    try {
      console.log('[API] Essai PMU API...');
      const data = await scraperPMUApi(date, reunion, numCourse);
      if (data && data.partants.length > 2) {
        if (verifierHippodrome(data, hippodrome)) {
          console.log(`[API] PMU API OK: ${data.partants.length} partants - ${data.course.nom}`);
          return res.json({ ...data, date, nomCourse, hippodrome });
        } else {
          console.log(`[API] PMU hippodrome mismatch: ${data.course.hippodrome} vs ${hippodrome}`);
          erreurs.push({ source: 'pmu', error: 'hippodrome mismatch: ' + data.course.hippodrome });
        }
      }
    } catch(err) {
      console.log(`[API] PMU erreur: ${err.message}`);
      erreurs.push({ source: 'pmu', error: err.message });
    }
  }

  // Essai 2: Geny (avec interception réseau)
  if (nomCourse && hippodrome) {
    try {
      console.log('[API] Essai Geny...');
      const data = await scraperGeny(date, nomCourse, hippodrome, courseId);
      if (data && data.partants.length > 2) {
        console.log(`[API] Geny OK: ${data.partants.length} partants`);
        return res.json({ ...data, date, nomCourse, hippodrome });
      }
    } catch(err) {
      console.log(`[API] Geny erreur: ${err.message}`);
      erreurs.push({ source: 'geny', error: err.message });
    }
  }

  // Essai 3: Equidia
  if (reunion && numCourse) {
    try {
      console.log('[API] Essai Equidia...');
      const data = await scraperEquidia(date, reunion, numCourse);
      if (data && data.partants.length > 2) {
        console.log(`[API] Equidia OK: ${data.partants.length} partants`);
        return res.json({ ...data, date, nomCourse, hippodrome });
      }
    } catch(err) {
      console.log(`[API] Equidia erreur: ${err.message}`);
      erreurs.push({ source: 'equidia', error: err.message });
    }
  }

  console.log('[API] Toutes sources echouees');
  res.status(404).json({
    partants: [], date, nomCourse, hippodrome, erreurs,
    message: 'Partants non trouves - Claude va chercher via recherche web'
  });
});

app.listen(PORT, () => {
  console.log(`\nTurf Scraper API v2.0 - Port ${PORT}`);
});
