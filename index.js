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

export async function fetchTournamentData(tournamentURL) {
    const { id, window } = getTournamentID(tournamentURL);
    const fullEndpoint = endpoint.replace('{eventId}', id).replace('{windowId}', window);
    const fullURL = baseURL + fullEndpoint;

    const response = await axios.get(fullURL, {
        headers: {
            'x-api-key': key
        }
    });

    if (!response.data?.success || !response.data?.data) {
        const err = new Error(response.data?.message || "Réponse inattendue de l'API du tournoi.");
        err.status = 502;
        throw err;
    }

    return response.data.data;
}