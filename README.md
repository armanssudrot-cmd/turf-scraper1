# Turf Scraper API

Backend Node.js + Puppeteer pour récupérer les partants PMU en temps réel.

## Déploiement sur Railway

### 1. Créer un compte Railway
Va sur https://railway.app et connecte-toi avec ton compte GitHub.

### 2. Nouveau projet
- Clique "New Project"
- Choisis "Deploy from GitHub repo"
- Sélectionne le repo `turf-scraper`

### 3. Variables d'environnement (optionnel)
Dans Railway → Variables :
```
PORT=3001
NODE_ENV=production
```

### 4. Récupérer l'URL publique
Railway te donne une URL du type :
`https://turf-scraper-production.up.railway.app`

### 5. Mettre à jour l'app Netlify
Dans le HTML de ton app Netlify, remplace :
```javascript
var SCRAPER_URL = 'https://TON-APP.up.railway.app';
```

## API Endpoints

### GET /
Health check
```json
{ "status": "ok", "service": "Turf Scraper API" }
```

### POST /partants
Récupérer les partants d'une course.

**Body:**
```json
{
  "date": "2026-05-27",
  "nomCourse": "Prix De Roquancourt",
  "hippodrome": "Caen",
  "reunion": "R2",
  "numCourse": "C3",
  "courseId": "1654963"
}
```

**Réponse succès:**
```json
{
  "date": "2026-05-27",
  "nomCourse": "Prix De Roquancourt",
  "partants": [
    {
      "num": "1",
      "nom": "RAPID HORSE",
      "driver": "M. DUPONT",
      "entraineur": "J. MARTIN",
      "cote": "3.5",
      "musique": "2m1m3m",
      "gains_total": 15000,
      "nb_courses": 12
    }
  ],
  "source": "geny"
}
```

**Réponse échec (404):**
```json
{
  "partants": [],
  "message": "Partants non trouvés. Claude va chercher via recherche web.",
  "erreurs": [...]
}
```

## Sources utilisées dans l'ordre
1. **Geny.com** - partants + musique + gains
2. **Equidia.fr** - partants + cotes
3. **API PMU officielle** - partants + cotes officielles

## Développement local
```bash
npm install
node server.js
# API dispo sur http://localhost:3001
```
