import 'dotenv/config';
import axios from 'axios';

const key = process.env.key;
const baseURL = "https://api.citoapi.com/api/v1";
const endpoint = "/fortnite/tournaments/live/{eventId}/{windowId}";

export function getTournamentID(tournamentURL) {
    let parsed;
    try {
        parsed = new URL(tournamentURL);
    } catch {
        const err = new Error("Lien de tournoi invalide (URL mal formée).");
        err.status = 400;
        throw err;
    }

    const segments = parsed.pathname.split('/').filter(Boolean);
    const id = segments[segments.length - 1];
    const window = parsed.searchParams.get('window');

    if (!id || !window) {
        const err = new Error('Lien de tournoi invalide : il doit contenir l\'identifiant de l\'événement et un paramètre "window".');
        err.status = 400;
        throw err;
    }

    return { id, window };
}

const DEFAULT_MAX_PAGES = 50;

async function requestLeaderboardPage(fullURL, params) {
    const response = await axios.get(fullURL, {
        headers: {
            'x-api-key': key
        },
        params
    });

    if (!response.data?.success || !response.data?.data) {
        const err = new Error(response.data?.message || "Réponse inattendue de l'API du tournoi.");
        err.status = 502;
        throw err;
    }

    return response.data.data;
}

export async function fetchTournamentData(tournamentURL) {
    const { id, window } = getTournamentID(tournamentURL);
    const fullEndpoint = endpoint.replace('{eventId}', id).replace('{windowId}', window);
    const fullURL = baseURL + fullEndpoint;

    // 1 seul appel sans "page" : l'API renvoie tout le classement d'un coup tant
    // qu'il tient sous son plafond interne (le cas le plus fréquent, et le moins
    // coûteux en quota).
    let current = await requestLeaderboardPage(fullURL, {});
    if (!current.hasMore) {
        return current;
    }

    // Classement trop volumineux pour tenir dans une seule réponse : bascule sur
    // la pagination explicite ("page" est 0-indexée côté API) jusqu'à ce que
    // hasMore devienne false, ou qu'on atteigne le plafond maxPages annoncé par
    // l'API (garde-fou contre une boucle infinie).
    const maxPages = current.maxPages || DEFAULT_MAX_PAGES;
    let leaderboard = [];
    let page = 0;

    while (true) {
        const pageTeams = current.leaderboard || [];
        leaderboard = leaderboard.concat(pageTeams);

        const reachedCap = page + 1 >= maxPages;
        if (!current.hasMore || pageTeams.length === 0 || reachedCap) break;

        page++;
        current = await requestLeaderboardPage(fullURL, { page });
    }

    current.leaderboard = leaderboard;
    return current;
}