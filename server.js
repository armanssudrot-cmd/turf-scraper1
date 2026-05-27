const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ── UTILITAIRES ──────────────────────────────────────────────

function slugify(str) {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function getBrowser() {
  return await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process'
    ]
  });
}

// ── SCRAPER GENY ─────────────────────────────────────────────

async function scraperGeny(date, nomCourse, hippodrome, courseId) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    // Construire l'URL Geny
    let url;
    if (courseId) {
      url = `https://www.geny.com/partants-pmu/${date}-${slugify(hippodrome)}-pmu-${slugify(nomCourse)}_c${courseId}`;
    } else {
      url = `https://www.geny.com/partants-pmu/${date}-${slugify(hippodrome)}-pmu-${slugify(nomCourse)}`;
    }

    console.log(`[Geny] Fetching: ${url}`);
    
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Attendre que les partants chargent
    await page.waitForSelector('.partant, .cheval, [data-partant]', { timeout: 10000 })
      .catch(() => console.log('[Geny] Sélecteur partants pas trouvé, on continue'));

    // Extraire les données via le DOM et les scripts
    const data = await page.evaluate(() => {
      const result = {
        source: 'geny',
        course: {},
        partants: []
      };

      // Infos course
      const titreEl = document.querySelector('h1, .titre-course, .course-title');
      if (titreEl) result.course.nom = titreEl.textContent.trim();

      // Chercher le JSON dans les scripts de la page
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const content = script.textContent || '';
        
        // Chercher les données de partants dans les variables JS
        const partantsMatch = content.match(/partants\s*[:=]\s*(\[[\s\S]{100,}\])/);
        if (partantsMatch) {
          try {
            const partants = JSON.parse(partantsMatch[1]);
            result.partants = partants;
            result.source_type = 'json_script';
            return result;
          } catch(e) {}
        }

        // Chercher window.__data ou similaire
        const dataMatch = content.match(/window\.__(?:data|state|app)\s*=\s*(\{[\s\S]{100,}\})/);
        if (dataMatch) {
          try {
            const appData = JSON.parse(dataMatch[1]);
            if (appData.partants || appData.participants || appData.runners) {
              result.partants = appData.partants || appData.participants || appData.runners || [];
              result.app_data = appData;
              return result;
            }
          } catch(e) {}
        }
      }

      // Fallback: scraper le HTML des tableaux de partants
      const rows = document.querySelectorAll('tr.partant, .liste-partants tr, .partant-row, tbody tr');
      rows.forEach((row, idx) => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 3) {
          const partant = {
            num: cells[0]?.textContent?.trim() || String(idx + 1),
            nom: cells[1]?.textContent?.trim() || cells[2]?.textContent?.trim() || '',
            driver: '',
            entraineur: '',
            cote: '',
            musique: '',
          };
          
          // Chercher driver et musique dans les cellules
          cells.forEach(cell => {
            const txt = cell.textContent.trim();
            if (txt.match(/^[0-9]+[am][0-9]+/)) partant.musique = txt;
            if (cell.className?.includes('driver') || cell.className?.includes('jockey')) partant.driver = txt;
            if (cell.className?.includes('entraineur') || cell.className?.includes('trainer')) partant.entraineur = txt;
            if (txt.match(/^\d+\.?\d*$/) && parseFloat(txt) > 1) partant.cote = txt;
          });

          if (partant.nom && partant.nom.length > 1) {
            result.partants.push(partant);
          }
        }
      });

      // Chercher les noms dans les liens chevaux
      if (result.partants.length === 0) {
        const chevaux = document.querySelectorAll('a[href*="/cheval/"], a[href*="/horse/"], .nom-cheval');
        chevaux.forEach((el, idx) => {
          result.partants.push({
            num: String(idx + 1),
            nom: el.textContent.trim(),
            driver: '', entraineur: '', cote: '', musique: ''
          });
        });
      }

      return result;
    });

    await browser.close();
    return data;

  } catch (err) {
    await browser.close();
    throw err;
  }
}

// ── SCRAPER EQUIDIA ──────────────────────────────────────────

async function scraperEquidia(date, reunion, numCourse) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36');
    
    const url = `https://www.equidia.fr/courses/${date}/${reunion}/${numCourse}`;
    console.log(`[Equidia] Fetching: ${url}`);
    
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Attendre le chargement des partants
    await page.waitForSelector('.runner, .participant, [class*="runner"], [class*="horse"]', { timeout: 15000 })
      .catch(() => console.log('[Equidia] Sélecteur pas trouvé'));

    // Attendre un peu plus pour le JS dynamique
    await new Promise(r => setTimeout(r, 2000));

    const data = await page.evaluate(() => {
      const result = {
        source: 'equidia',
        course: {},
        partants: []
      };

      // Chercher les données dans le state React/Vue
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const content = script.textContent || '';
        
        // Next.js / Nuxt data
        const nextData = content.match(/__NEXT_DATA__\s*=\s*(\{[\s\S]+\})/);
        if (nextData) {
          try {
            const nd = JSON.parse(nextData[1]);
            const props = nd?.props?.pageProps;
            if (props?.runners || props?.participants || props?.partants) {
              result.partants = props.runners || props.participants || props.partants;
              result.course = props.race || props.course || {};
              return result;
            }
            // Chercher en profondeur
            const str = JSON.stringify(nd);
            const runnerMatch = str.match(/"runners":\s*(\[[\s\S]{50,}\])/);
            if (runnerMatch) {
              result.partants = JSON.parse(runnerMatch[1]);
              return result;
            }
          } catch(e) {}
        }

        // Variables window
        const windowData = content.match(/window\.(?:__data|__store|__state)\s*=\s*(\{[\s\S]{100,}\})/);
        if (windowData) {
          try {
            const wd = JSON.parse(windowData[1]);
            result.raw_data = wd;
            return result;
          } catch(e) {}
        }
      }

      // Scraper le DOM HTML
      // Chercher les lignes de partants
      const selectors = [
        '[class*="RunnerRow"]',
        '[class*="runner-row"]', 
        '[class*="HorseRow"]',
        '[class*="participant"]',
        '.runners-list > div',
        'table tbody tr'
      ];

      for (const sel of selectors) {
        const elements = document.querySelectorAll(sel);
        if (elements.length > 2) {
          elements.forEach((el, idx) => {
            const txt = el.textContent;
            const numMatch = txt.match(/^(\d+)/);
            const nomMatch = txt.match(/[A-Z][A-Z\s']{3,}/);
            
            if (nomMatch) {
              result.partants.push({
                num: numMatch ? numMatch[1] : String(idx + 1),
                nom: nomMatch[0].trim(),
                driver: '',
                entraineur: '',
                cote: '',
                musique: '',
                raw: txt.trim().substring(0, 200)
              });
            }
          });
          if (result.partants.length > 0) break;
        }
      }

      // Infos course
      const titreEl = document.querySelector('h1, [class*="RaceName"], [class*="race-name"], [class*="courseName"]');
      if (titreEl) result.course.nom = titreEl.textContent.trim();

      const metaEls = document.querySelectorAll('[class*="meta"], [class*="Meta"], [class*="info"]');
      metaEls.forEach(el => {
        const txt = el.textContent.trim();
        if (txt.match(/\d+m/)) result.course.distance = txt;
        if (txt.match(/\d+h\d+/)) result.course.heure = txt;
      });

      return result;
    });

    await browser.close();
    return data;

  } catch (err) {
    await browser.close();
    throw err;
  }
}

// ── SCRAPER PMU API ──────────────────────────────────────────

async function scraperPMUApi(date, reunion, course) {
  // L'API PMU officielle - format date: DDMMYYYY
  const dateFormatted = date.replace(/-/g, '').split('').reverse().join('').match(/.{1,2}/g).join('').split('').reverse().join('');
  // YYYY-MM-DD -> DDMMYYYY
  const parts = date.split('-');
  const datePMU = parts[2] + parts[1] + parts[0];
  
  const reunionNum = reunion.replace('R', '');
  const courseNum = course.replace('C', '');
  
  const url = `https://online.turfinfo.api.pmu.fr/rest/client/7/programme/${datePMU}/${reunion}/${course}/participants`;
  
  console.log(`[PMU API] Fetching: ${url}`);
  
  const browser = await getBrowser();
  const page = await browser.newPage();
  
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120');
    
    const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
    const content = await page.content();
    
    // Extraire le JSON du body
    const jsonMatch = content.match(/<pre[^>]*>([\s\S]+)<\/pre>/) || content.match(/<body[^>]*>([\s\S]+)<\/body>/);
    
    if (jsonMatch) {
      try {
        const data = JSON.parse(jsonMatch[1].trim());
        await browser.close();
        return { source: 'pmu_api', data };
      } catch(e) {}
    }
    
    await browser.close();
    return null;
  } catch(err) {
    await browser.close();
    return null;
  }
}

// ── NORMALISER LES DONNÉES ───────────────────────────────────

function normaliserPartants(rawData, source) {
  if (!rawData) return [];
  
  const partants = rawData.partants || rawData.runners || rawData.participants || [];
  
  return partants.map((p, idx) => {
    // Geny format
    if (source === 'geny') {
      return {
        num: p.numero || p.num || p.numPmu || String(idx + 1),
        nom: p.nom || p.name || p.horseName || p.libelle || '',
        driver: p.driver || p.jockey || p.driverName || p.jockeyName || '',
        entraineur: p.entraineur || p.trainer || p.trainerName || '',
        cote: String(p.cote || p.odds || p.rapportSimpleGagnant || ''),
        musique: p.musique || p.music || p.formString || '',
        gains_total: p.gainsCarriere || p.totalGains || p.gains || 0,
        nb_courses: p.nbCourses || p.totalRuns || 0,
      };
    }
    
    // Equidia format
    if (source === 'equidia') {
      return {
        num: p.number || p.numero || p.num || String(idx + 1),
        nom: p.horseName || p.name || p.nom || p.horse?.name || '',
        driver: p.driverName || p.jockeyName || p.driver?.name || '',
        entraineur: p.trainerName || p.trainer?.name || '',
        cote: String(p.odds || p.cote || ''),
        musique: p.music || p.formString || p.musique || '',
        gains_total: p.totalGains || p.gains || 0,
        nb_courses: p.totalRuns || p.nbCourses || 0,
      };
    }

    // PMU API format
    if (source === 'pmu_api') {
      return {
        num: String(p.numPmu || p.numero || idx + 1),
        nom: p.nom || p.name || '',
        driver: p.driver?.nom || p.jockey?.nom || '',
        entraineur: p.entraineur?.nom || '',
        cote: String(p.rapportSimpleGagnant || ''),
        musique: p.musique || p.formString || '',
        gains_total: p.gainsCarriere || 0,
        nb_courses: p.nbCourses || 0,
      };
    }

    // Format générique
    return {
      num: p.num || p.numero || p.number || String(idx + 1),
      nom: p.nom || p.name || p.horseName || '',
      driver: p.driver || p.jockey || '',
      entraineur: p.entraineur || p.trainer || '',
      cote: String(p.cote || p.odds || ''),
      musique: p.musique || p.music || '',
      gains_total: p.gains || 0,
      nb_courses: p.courses || 0,
    };
  }).filter(p => p.nom && p.nom.length > 1);
}

// ── ROUTES API ───────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Turf Scraper API', version: '1.0.0' });
});

// Route principale: récupérer les partants
app.post('/partants', async (req, res) => {
  const { date, nomCourse, hippodrome, reunion, numCourse, courseId } = req.body;

  if (!date || !nomCourse) {
    return res.status(400).json({ error: 'date et nomCourse requis' });
  }

  console.log(`\n[API] Requête partants:`, { date, nomCourse, hippodrome, reunion, numCourse });

  const results = {
    date,
    nomCourse,
    hippodrome,
    partants: [],
    source: null,
    erreurs: []
  };

  // Essai 1: Geny
  try {
    console.log('[API] Essai Geny...');
    const genyData = await scraperGeny(date, nomCourse, hippodrome, courseId);
    const partants = normaliserPartants(genyData, 'geny');
    
    if (partants.length > 2) {
      results.partants = partants;
      results.source = 'geny';
      results.course = genyData.course;
      console.log(`[API] Geny OK: ${partants.length} partants`);
      return res.json(results);
    }
    console.log(`[API] Geny insuffisant: ${partants.length} partants`);
  } catch (err) {
    console.log(`[API] Geny erreur: ${err.message}`);
    results.erreurs.push({ source: 'geny', error: err.message });
  }

  // Essai 2: Equidia
  if (reunion && numCourse) {
    try {
      console.log('[API] Essai Equidia...');
      const equidiaData = await scraperEquidia(date, reunion, numCourse);
      const partants = normaliserPartants(equidiaData, 'equidia');
      
      if (partants.length > 2) {
        results.partants = partants;
        results.source = 'equidia';
        results.course = equidiaData.course;
        console.log(`[API] Equidia OK: ${partants.length} partants`);
        return res.json(results);
      }
      console.log(`[API] Equidia insuffisant: ${partants.length} partants`);
      
      // Même si les partants sont vides, garder les données brutes pour Claude
      if (equidiaData.raw_data || equidiaData.partants?.length > 0) {
        results.raw_equidia = equidiaData;
      }
    } catch (err) {
      console.log(`[API] Equidia erreur: ${err.message}`);
      results.erreurs.push({ source: 'equidia', error: err.message });
    }
  }

  // Essai 3: PMU API
  if (reunion && numCourse) {
    try {
      console.log('[API] Essai PMU API...');
      const pmuData = await scraperPMUApi(date, reunion, numCourse);
      
      if (pmuData?.data?.participants?.length > 0) {
        results.partants = normaliserPartants(pmuData.data, 'pmu_api');
        results.source = 'pmu_api';
        console.log(`[API] PMU API OK: ${results.partants.length} partants`);
        return res.json(results);
      }
    } catch (err) {
      console.log(`[API] PMU API erreur: ${err.message}`);
      results.erreurs.push({ source: 'pmu_api', error: err.message });
    }
  }

  // Aucune source n'a fonctionné
  console.log('[API] Toutes les sources ont échoué');
  res.status(404).json({
    ...results,
    message: 'Partants non trouvés sur aucune source. Claude va chercher via recherche web.'
  });
});

// Route test pour vérifier qu'une URL est accessible
app.get('/test', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url requis' });
  
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
    const title = await page.title();
    const content = await page.content();
    await browser.close();
    res.json({ title, contentLength: content.length, status: 'ok' });
  } catch(err) {
    await browser.close();
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🏇 Turf Scraper API démarré sur port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/`);
  console.log(`   Partants: POST http://localhost:${PORT}/partants`);
});
