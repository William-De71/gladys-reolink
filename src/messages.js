// -----------------------------------------------------------------------------
// Every message this integration shows to the user, in the four languages of
// Gladys (en, fr, de, es).
//
// Gathered here rather than inline in `index.js`: a message added in English
// only would show up in English in a German interface, and keeping them side by
// side is what makes a missing translation visible in review. The manifest test
// checks that every entry carries the four languages.
//
// The connection status and the action results take a `{ en, fr, de, es }`
// object; Gladys picks the user's language and falls back to English.
// -----------------------------------------------------------------------------

/**
 * Messages without parameters, and builders for the ones that carry values.
 * Values (camera names, error codes) are never translated.
 */
export const MESSAGES = {
  notConfigured: {
    en: 'Fill in the username and password of your cameras to find them.',
    fr: "Renseignez l'identifiant et le mot de passe de vos caméras pour les trouver.",
    de: 'Geben Sie den Benutzernamen und das Passwort Ihrer Kameras ein, um sie zu finden.',
    es: 'Introduzca el usuario y la contraseña de sus cámaras para encontrarlas.',
  },
  noCameraFound: {
    en: 'No camera found. Check that your cameras are powered on and reachable from Gladys, or enter their addresses manually.',
    fr: 'Aucune caméra trouvée. Vérifiez que vos caméras sont allumées et joignables depuis Gladys, ou saisissez leurs adresses manuellement.',
    de: 'Keine Kamera gefunden. Prüfen Sie, ob Ihre Kameras eingeschaltet und von Gladys aus erreichbar sind, oder geben Sie ihre Adressen manuell ein.',
    es: 'No se ha encontrado ninguna cámara. Compruebe que sus cámaras estén encendidas y sean accesibles desde Gladys, o introduzca sus direcciones manualmente.',
  },
  initFailed: {
    en: 'Initialization failed, check the integration logs.',
    fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
    de: 'Die Initialisierung ist fehlgeschlagen, prüfen Sie die Protokolle der Integration.',
    es: 'La inicialización ha fallado, consulte los registros de la integración.',
  },
  testNotConfigured: {
    en: 'Fill in the username and password of your cameras first.',
    fr: "Renseignez d'abord l'identifiant et le mot de passe de vos caméras.",
    de: 'Geben Sie zuerst den Benutzernamen und das Passwort Ihrer Kameras ein.',
    es: 'Introduzca primero el usuario y la contraseña de sus cámaras.',
  },
  testNoAnswer: {
    en: 'No camera answered. Check that your cameras are powered on and on the same network as Gladys, or enter their addresses under "Camera addresses".',
    fr: "Aucune caméra n'a répondu. Vérifiez que vos caméras sont allumées et sur le même réseau que Gladys, ou saisissez leurs adresses dans « Adresses des caméras ».",
    de: 'Keine Kamera hat geantwortet. Prüfen Sie, ob Ihre Kameras eingeschaltet und im selben Netzwerk wie Gladys sind, oder geben Sie ihre Adressen unter „Kameraadressen“ ein.',
    es: 'Ninguna cámara ha respondido. Compruebe que sus cámaras estén encendidas y en la misma red que Gladys, o introduzca sus direcciones en «Direcciones de las cámaras».',
  },
  testAuthRefused: {
    en: 'Connection refused: check the username and password of your cameras.',
    fr: "Connexion refusée : vérifiez l'identifiant et le mot de passe de vos caméras.",
    de: 'Verbindung abgelehnt: Prüfen Sie den Benutzernamen und das Passwort Ihrer Kameras.',
    es: 'Conexión rechazada: compruebe el usuario y la contraseña de sus cámaras.',
  },
  noPtzCamera: {
    en: 'No camera with PTZ presets was found. Only motorized cameras have them.',
    fr: 'Aucune caméra avec des positions PTZ trouvée. Seules les caméras motorisées en possèdent.',
    de: 'Keine Kamera mit PTZ-Positionen gefunden. Nur motorisierte Kameras besitzen welche.',
    es: 'No se ha encontrado ninguna cámara con posiciones PTZ. Solo las cámaras motorizadas las tienen.',
  },
  noCameraCreated: {
    en: 'No camera created yet. Run a scan from the Discover screen first.',
    fr: "Aucune caméra créée pour l'instant. Lancez d'abord un scan depuis l'écran Découverte.",
    de: 'Noch keine Kamera angelegt. Starten Sie zuerst eine Suche im Bildschirm „Entdecken“.',
    es: 'Todavía no se ha creado ninguna cámara. Lance primero una búsqueda desde la pantalla Descubrir.',
  },
};

/**
 * Build the result of a successful connection test.
 * @param {number} count - How many cameras answered.
 * @param {object} details - Per-language summaries, already joined.
 * @returns {object} The multi-language message.
 * @example
 * testOk(2, { en: 'Garden (...)', fr: 'Jardin (...)', de: '...', es: '...' });
 */
export function testOk(count, details) {
  return {
    en: `Connection OK: ${count} camera(s) found — ${details.en}.`,
    fr: `Connexion OK : ${count} caméra(s) trouvée(s) — ${details.fr}.`,
    de: `Verbindung OK: ${count} Kamera(s) gefunden — ${details.de}.`,
    es: `Conexión correcta: ${count} cámara(s) encontrada(s) — ${details.es}.`,
  };
}

/**
 * Build the message for cameras that exist but keep their API closed.
 *
 * Its own message rather than "no camera found": the camera is right there,
 * often already streaming over RTSP, and what is missing is one switch in the
 * Reolink app that the user would otherwise never think of.
 * @param {string[]} addresses - The addresses that did not answer.
 * @returns {object} The multi-language message.
 * @example
 * apiUnreachable(['192.168.1.42']);
 */
export function apiUnreachable(addresses) {
  const list = addresses.join(', ');
  return {
    en: `No answer from ${list}. Check the address, then in the Reolink app enable HTTP or HTTPS (Settings → Network → Advanced → Server settings): RTSP alone is not enough.`,
    fr: `Aucune réponse de ${list}. Vérifiez l'adresse, puis dans l'application Reolink activez HTTP ou HTTPS (Paramètres → Réseau → Avancé → Paramètres du serveur) : RTSP seul ne suffit pas.`,
    de: `Keine Antwort von ${list}. Prüfen Sie die Adresse und aktivieren Sie dann in der Reolink-App HTTP oder HTTPS (Einstellungen → Netzwerk → Erweitert → Servereinstellungen): RTSP allein reicht nicht.`,
    es: `Sin respuesta de ${list}. Compruebe la dirección y, en la aplicación Reolink, active HTTP o HTTPS (Ajustes → Red → Avanzado → Ajustes del servidor): RTSP por sí solo no basta.`,
  };
}

/**
 * Build the result of a failed connection test.
 * @param {string} reason - The technical reason, left untranslated.
 * @returns {object} The multi-language message.
 * @example
 * testFailed('REOLINK_TIMEOUT');
 */
export function testFailed(reason) {
  return {
    en: `Connection failed: ${reason}`,
    fr: `Échec de la connexion : ${reason}`,
    de: `Verbindung fehlgeschlagen: ${reason}`,
    es: `Error de conexión: ${reason}`,
  };
}

/**
 * The per-camera notes of the connection test: what is worth knowing about a
 * camera beyond "it answered", in each language.
 */
export const CAMERA_NOTES = {
  onvif: {
    en: 'instant detections (ONVIF)',
    fr: 'détections instantanées (ONVIF)',
    de: 'sofortige Erkennungen (ONVIF)',
    es: 'detecciones instantáneas (ONVIF)',
  },
  polled: {
    en: 'detections checked periodically',
    fr: 'détections vérifiées périodiquement',
    de: 'Erkennungen werden regelmäßig abgefragt',
    es: 'detecciones comprobadas periódicamente',
  },
  rtspDisabled: {
    en: 'RTSP disabled: no live view',
    fr: 'RTSP désactivé : pas de vidéo en direct',
    de: 'RTSP deaktiviert: keine Live-Ansicht',
    es: 'RTSP desactivado: sin vídeo en directo',
  },
};

/**
 * Build the list of saved PTZ presets.
 * @param {Array<{ name: string, presets: Array<{ id: number, name: string }>|null, error?: string }>} cameras -
 * One entry per camera: its presets, or null with an error when unreadable.
 * @returns {object} The multi-language message.
 * @example
 * presetList([{ name: 'Gate', presets: [{ id: 1, name: 'Door' }] }]);
 */
export function presetList(cameras) {
  const words = {
    en: { title: 'Saved presets', none: 'no preset saved yet', unreadable: 'unreadable' },
    fr: {
      title: 'Positions enregistrées',
      none: 'aucune position enregistrée',
      unreadable: 'illisible',
    },
    de: {
      title: 'Gespeicherte Positionen',
      none: 'noch keine Position gespeichert',
      unreadable: 'nicht lesbar',
    },
    es: {
      title: 'Posiciones guardadas',
      none: 'ninguna posición guardada todavía',
      unreadable: 'ilegible',
    },
  };
  return Object.fromEntries(
    Object.entries(words).map(([language, word]) => {
      const lines = cameras.map((camera) => {
        if (!camera.presets) {
          return `${camera.name}: ${word.unreadable} (${camera.error})`;
        }
        if (camera.presets.length === 0) {
          return `${camera.name}: ${word.none}`;
        }
        return `${camera.name}: ${camera.presets.map((preset) => `${preset.id} = ${preset.name}`).join(', ')}`;
      });
      return [language, `${word.title} — ${lines.join(' | ')}`];
    }),
  );
}

/**
 * Build the result of the "refresh the images" action.
 * @param {number} published - How many images were published.
 * @param {string[]} failures - The cameras that could not be captured.
 * @returns {object} The multi-language message.
 * @example
 * refreshResult(2, ['Garage']);
 */
export function refreshResult(published, failures) {
  const failed = failures.join(', ');
  if (failures.length === 0) {
    return {
      en: `${published} image(s) refreshed.`,
      fr: `${published} image(s) rafraîchie(s).`,
      de: `${published} Bild(er) aktualisiert.`,
      es: `${published} imagen(es) actualizada(s).`,
    };
  }
  return {
    en: `${published} image(s) refreshed. Failed: ${failed}.`,
    fr: `${published} image(s) rafraîchie(s). Échec : ${failed}.`,
    de: `${published} Bild(er) aktualisiert. Fehlgeschlagen: ${failed}.`,
    es: `${published} imagen(es) actualizada(s). Error: ${failed}.`,
  };
}
