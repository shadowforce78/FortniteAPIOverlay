import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchTournamentData } from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const CACHE_PATH = path.join(DATA_DIR, 'cache.json');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function readJSON(filePath, fallback) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
        return fallback;
    }
}

function writeJSON(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

app.get('/', (req, res) => res.redirect('/config.html'));

const MODES = ['solo', 'duo', 'trio'];

// Un "slot" = un joueur suivi (dans un mode donné) = une page d'overlay (/overlay.html?slot=<id>)
function normalizeConfig(raw) {
    const tournamentURLs = { solo: '', duo: '', trio: '', ...raw?.tournamentURLs };
    let slots = Array.isArray(raw?.slots) ? raw.slots : [];

    // Anciens formats : un seul lien global, et/ou des slots sans "mode"
    if (slots.length === 0 && raw?.selectedPlayer) {
        slots.push({ id: '1', label: 'Joueur 1', mode: 'solo', selectedPlayer: raw.selectedPlayer });
    }
    if (raw?.tournamentURL && !tournamentURLs.solo && !tournamentURLs.duo && !tournamentURLs.trio) {
        tournamentURLs.solo = raw.tournamentURL;
    }
    slots = slots.map(s => ({ mode: MODES.includes(s.mode) ? s.mode : 'solo', ...s }));

    return { tournamentURLs, slots };
}

function readConfig() {
    return normalizeConfig(readJSON(CONFIG_PATH, {}));
}

function readCache() {
    return readJSON(CACHE_PATH, {});
}

function nextSlotId(slots) {
    const max = slots.reduce((m, s) => Math.max(m, parseInt(s.id, 10) || 0), 0);
    return String(max + 1);
}

// Aplatit le classement par équipes en une liste de joueurs individuels
// (chaque coéquipier hérite du rang/score/matchs de son équipe)
function flattenLeaderboard(modeCache) {
    if (!modeCache) return [];
    return modeCache.leaderboard.flatMap(team =>
        team.members.map(member => ({
            displayName: member.displayName,
            teamDisplayName: team.teamDisplayName,
            rank: team.rank,
            score: team.score,
            matchesPlayed: team.matchesPlayed
        }))
    );
}

function isValidMode(mode) {
    return MODES.includes(mode);
}

// Config actuelle (liens de tournoi par mode + liste des emplacements suivis)
app.get('/api/config', (req, res) => {
    res.json(readConfig());
});

// Met à jour le lien de tournoi d'un mode donné
app.post('/api/config', (req, res) => {
    const config = readConfig();
    const { mode, tournamentURL } = req.body || {};
    if (isValidMode(mode) && typeof tournamentURL === 'string') {
        config.tournamentURLs[mode] = tournamentURL;
    }
    writeJSON(CONFIG_PATH, config);
    res.json(config);
});

// Ajoute un emplacement (joueur suivi)
app.post('/api/slots', (req, res) => {
    const config = readConfig();
    const id = nextSlotId(config.slots);
    const slot = {
        id,
        label: req.body?.label || `Joueur ${id}`,
        mode: isValidMode(req.body?.mode) ? req.body.mode : 'solo',
        selectedPlayer: req.body?.selectedPlayer || null
    };
    config.slots.push(slot);
    writeJSON(CONFIG_PATH, config);
    res.json(slot);
});

// Met à jour un emplacement (nom affiché, mode et/ou joueur sélectionné)
app.put('/api/slots/:id', (req, res) => {
    const config = readConfig();
    const slot = config.slots.find(s => s.id === req.params.id);
    if (!slot) return res.status(404).json({ error: 'Emplacement introuvable.' });
    if (typeof req.body?.label === 'string') slot.label = req.body.label;
    if (isValidMode(req.body?.mode)) slot.mode = req.body.mode;
    if ('selectedPlayer' in (req.body || {})) slot.selectedPlayer = req.body.selectedPlayer || null;
    writeJSON(CONFIG_PATH, config);
    res.json(slot);
});

// Supprime un emplacement
app.delete('/api/slots/:id', (req, res) => {
    const config = readConfig();
    config.slots = config.slots.filter(s => s.id !== req.params.id);
    writeJSON(CONFIG_PATH, config);
    res.json({ ok: true });
});

// Classement mis en cache pour un mode (aplati par joueur, pour peupler le sélecteur)
app.get('/api/players', (req, res) => {
    const mode = isValidMode(req.query.mode) ? req.query.mode : 'solo';
    const modeCache = readCache()[mode];
    if (!modeCache) return res.json({ fetchedAt: null, tournamentName: null, players: [] });
    res.json({
        fetchedAt: modeCache.fetchedAt,
        tournamentName: modeCache.tournamentName,
        teamCount: modeCache.leaderboard.length,
        players: flattenLeaderboard(modeCache)
    });
});

// Déclenche un appel à l'API du tournoi pour un mode (consomme le quota) et met à jour le cache
app.post('/api/refresh', async (req, res) => {
    const config = readConfig();
    const mode = isValidMode(req.body?.mode) ? req.body.mode : 'solo';
    const tournamentURL = req.body?.tournamentURL || config.tournamentURLs[mode];

    if (!tournamentURL) {
        return res.status(400).json({ error: "Aucun lien de tournoi renseigné pour ce mode." });
    }

    try {
        const data = await fetchTournamentData(tournamentURL);
        const cache = readCache();
        cache[mode] = {
            fetchedAt: new Date().toISOString(),
            tournamentName: data.name,
            eventId: data.eventId,
            eventWindowId: data.eventWindowId,
            leaderboard: data.leaderboard.map(team => ({
                rank: team.rank,
                teamDisplayName: team.displayName,
                score: team.score,
                matchesPlayed: team.matchesPlayed,
                members: (team.teamMembers || [{ displayName: team.displayName }]).map(m => ({ displayName: m.displayName }))
            }))
        };
        writeJSON(CACHE_PATH, cache);
        config.tournamentURLs[mode] = tournamentURL;
        writeJSON(CONFIG_PATH, config);
        res.json({
            ok: true,
            mode,
            fetchedAt: cache[mode].fetchedAt,
            tournamentName: cache[mode].tournamentName,
            teamCount: cache[mode].leaderboard.length
        });
    } catch (error) {
        console.error('Erreur /api/refresh:', error.response?.status || error.status, error.response?.data || error.message);
        const status = error.status || error.response?.status;
        const message = status === 429
            ? "Quota mensuel de l'API atteint."
            : error.response?.data?.message || error.message || "Erreur lors de la récupération des données.";
        res.status(status && status < 500 ? status : 502).json({ error: message });
    }
});

// Données affichées par l'overlay pour l'emplacement (slot) demandé
app.get('/api/overlay-data', (req, res) => {
    const config = readConfig();
    const slotId = req.query.slot || config.slots[0]?.id || '1';
    const slot = config.slots.find(s => s.id === slotId);
    const modeCache = slot ? readCache()[slot.mode] : null;

    if (!slot || !slot.selectedPlayer || !modeCache) {
        return res.json({ ready: false });
    }

    const team = modeCache.leaderboard.find(t => t.members.some(m => m.displayName === slot.selectedPlayer));
    if (!team) {
        return res.json({ ready: false, error: "Joueur introuvable dans les dernières données." });
    }

    res.json({
        ready: true,
        slot: slot.id,
        label: slot.label,
        mode: slot.mode,
        pseudo: slot.selectedPlayer,
        rank: team.rank,
        score: team.score,
        matchesPlayed: team.matchesPlayed,
        tournamentName: modeCache.tournamentName,
        fetchedAt: modeCache.fetchedAt
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Config : http://localhost:${PORT}/config.html`);
    console.log(`Overlay: http://localhost:${PORT}/overlay.html`);
});
