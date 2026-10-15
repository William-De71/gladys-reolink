# Reolink dans Gladys

Cette intégration amène vos caméras **Reolink** dans Gladys : l'image sur le tableau de bord, la vidéo en direct, des détections instantanées comme déclencheurs de scènes, et le pilotage du projecteur, de la sirène, des LED infrarouges et des têtes motorisées selon le modèle.

Tout se passe **sur votre réseau local**. Aucun compte Reolink n'est nécessaire, et aucune image ne transite par un cloud.

## Ce qu'il vous faut

- Une ou plusieurs caméras Reolink sur le même réseau que Gladys — autonomes, ou associées à un **Home Hub** ou un **NVR**.
- L'identifiant et le mot de passe que vous utilisez pour vous connecter à ces caméras (ceux de l'application Reolink, généralement `admin`).
- Gladys 5.0.0 ou plus récent.

C'est tout. Il n'y a ni compte à créer, ni clé d'API à demander.

> **Caméras sur batterie** (Argus, Go…) : elles sont en général jointes via leur Home Hub ou leur NVR — seules, la plupart n'offrent pas l'API locale qu'utilise cette intégration.

## Mise en place

1. Dans Gladys, ouvrez **Intégrations → Installer une intégration** et installez Reolink.
2. Dans l'écran de configuration, renseignez l'**identifiant** et le **mot de passe** de vos caméras.
3. Cliquez sur **Tester la connexion** : Gladys cherche vos caméras et indique ce que chacune sait faire, si elle signale ses détections instantanément, et si sa vidéo en direct est disponible.
4. Allez dans **Découverte** et lancez un scan : vos caméras y apparaissent, prêtes à être ajoutées. Derrière un Home Hub ou un NVR, chaque caméra devient un appareil à part entière.

### Réglages conseillés sur les caméras

Les firmwares Reolink récents sont livrés avec certains services réseau **désactivés**. Dans l'application Reolink, ouvrez **Paramètres → Réseau → Avancé → Paramètres du serveur** (l'intitulé varie légèrement selon la version de l'application) et activez :

- **HTTP** (ou **HTTPS**) — indispensable : c'est par là que Gladys dialogue avec la caméra. Sans lui, la caméra n'est jamais trouvée, même si son flux RTSP fonctionne ailleurs ;
- **RTSP** — nécessaire pour la vidéo en direct ;
- **ONVIF** — nécessaire pour les détections instantanées (voir plus bas).

Le test de connexion vous signale, caméra par caméra, quand RTSP est désactivé.

### Si une caméra n'est pas trouvée

Gladys cherche vos caméras par un broadcast réseau. Certains routeurs le filtrent, et une caméra sur un autre VLAN ne le reçoit jamais. Dans ce cas, saisissez son adresse dans **Adresses des caméras**, section Avancé :

```
192.168.1.42, 192.168.1.43
```

Si une caméra n'utilise pas le port standard, ajoutez-le : `192.168.1.42:8000`.

### Si vos caméras n'ont pas toutes le même mot de passe

Renseignez les exceptions dans **Comptes par caméra** :

```
192.168.1.42|gladys|MonMotDePasse
```

Les caméras absentes de cette liste utilisent le compte global.

## Ce que vous obtenez

Chaque caméra reçoit **les fonctionnalités qu'elle possède réellement**. L'intégration interroge la caméra plutôt que de se fier à son nom de modèle : deux caméras d'une même gamme peuvent différer.

| Fonctionnalité               | Sur quelles caméras                                 |
| ---------------------------- | --------------------------------------------------- |
| Image                        | Toutes                                              |
| Vidéo en direct              | Toutes (RTSP activé)                                |
| Mouvement                    | Toutes                                              |
| Personne / Véhicule / Animal | Modèles avec détection IA                           |
| Sonnette                     | Sonnettes vidéo                                     |
| Batterie                     | Modèles sur batterie et solaires                    |
| En charge                    | Modèles sur batterie et solaires                    |
| Projecteur                   | Modèles avec projecteur blanc                       |
| Sirène                       | Modèles avec haut-parleur d'alarme                  |
| Infrarouge                   | La plupart des modèles                              |
| Déplacement (flèches)        | Caméras motorisées (pan/tilt, ou zoom seul)         |
| Position                     | Caméras motorisées ayant des positions enregistrées |

### Détections

Une caméra peut signaler ce qu'elle voit de deux façons, et l'intégration choisit seule la meilleure pour chaque caméra :

- **Instantanément, via ONVIF** — les caméras filaires jointes directement **poussent** leurs événements de mouvement, de personne, de véhicule, d'animal et de sonnette à l'instant où ils se produisent, et signalent leur fin. C'est le fonctionnement par défaut, dès lors qu'ONVIF est activé sur la caméra.
- **Par vérification régulière** — les caméras sur batterie, celles derrière un Home Hub ou un NVR, et celles dont ONVIF est désactivé sont interrogées régulièrement. L'intervalle de vérification (15 secondes par défaut) est alors le délai de détection.

Si une caméra cesse de répondre en ONVIF, elle repasse d'elle-même en vérification régulière, et revient à ONVIF dès qu'elle répond de nouveau. Vous pouvez désactiver complètement ONVIF avec l'option **Détections instantanées (ONVIF)** de la section Avancé.

Une détection déclenche aussi une capture d'image, pour que le widget montre ce qui s'est passé sans attendre.

Les détections de personne, de véhicule et d'animal apparaissent comme des détecteurs de mouvement nommés « Person », « Vehicle » et « Animal » : utilisez-les dans un déclencheur de scène comme n'importe quel détecteur de mouvement, par exemple « quand une personne est détectée au portail, allumer la lumière de l'entrée ».

### Sonnette

Le bouton de la sonnette apparaît comme une fonctionnalité **Sonnette** : le tableau de bord affiche « Sonne » pendant un appel, puis l'heure du dernier, et l'éditeur de scènes propose **« Si la sonnette sonne »**.

### Caméras motorisées (PTZ)

- **Déplacement** affiche des flèches sur le tableau de bord. Chaque appui déplace la caméra d'un petit pas, qui s'arrête de lui-même — une scène qui envoie un mouvement ne laisse jamais la caméra tourner. Une caméra dotée seulement d'un zoom n'a que les boutons de zoom.
- **Position** liste, par leur nom, les positions enregistrées dans l'application Reolink. Choisissez-en une pour y envoyer la caméra, depuis le tableau de bord ou une scène.

La liste des positions est lue à la découverte de la caméra : après avoir enregistré une nouvelle position dans l'application Reolink, relancez un scan. L'action **Lister les positions PTZ** montre ce que chaque caméra a enregistré à l'instant.

### En charge

Les caméras sur batterie et solaires reçoivent aussi une fonctionnalité **En charge** : elle est active pendant que la caméra se recharge, sur son chargeur ou grâce à son panneau solaire, et inactive une fois la batterie pleine ou débranchée. Utilisez-la dans une scène — « quand la caméra du jardin cesse de se recharger, préviens-moi » — ou simplement pour vérifier qu'un panneau solaire fait toujours son travail.

## Protection de la batterie

Capturer une image est ce qui vide le plus une caméra sur batterie ou solaire. L'intégration lève donc le pied avant que la batterie n'atteigne un niveau critique :

- **sous 60 %** : le rafraîchissement automatique s'arrête. Ouvrir le widget ou une détection capture toujours une image ;
- **sous 40 %** : plus aucune image n'est capturée ;
- **retour à la normale** dès que la caméra est remise sur son chargeur, ou lorsqu'elle atteint **80 %** en solaire.

Ces 80 % sont volontairement bien au-dessus du seuil de pause : reprendre juste au-dessus relancerait aussitôt la décharge. Évitez de les régler à 100 % — une caméra solaire se recharge par à-coups et atteint rarement le plein exact, ce qui la laisserait en pause indéfiniment, sans chargeur sur lequel la poser.

Le niveau de batterie et les détections continuent d'être lus dans tous les cas : cela ne coûte presque rien, et c'est ce qui permet de savoir quand la caméra est rechargée.

Une caméra sur batterie qui **ne répond plus** — veille profonde, session refusée, réseau coupé — est également ramenée à la demande : son dernier niveau connu n'est plus fiable, et une caméra silencieuse a plus de chances d'être vide que pleine.

Derrière un Home Hub, le hub indique aussi quelles caméras sont **en veille** : une caméra en veille n'est jamais réveillée par le rafraîchissement automatique, quel que soit son niveau.

### Un intervalle de capture qui leur est propre

Les caméras sur batterie ont leur **propre intervalle de rafraîchissement**, indépendant de celui des caméras filaires. Espacer les captures d'un modèle solaire ne coûte donc rien à la fraîcheur de vos caméras sur secteur.

| Réglage                                   | Par défaut     | S'applique à                     |
| ----------------------------------------- | -------------- | -------------------------------- |
| Intervalle de rafraîchissement des images | 60 s           | caméras filaires uniquement      |
| Intervalle des caméras sur batterie       | 900 s (15 min) | modèles sur batterie ou solaires |

C'est le réglage le plus efficace de tous : ce qui coûte de la batterie, c'est **réveiller la caméra**, bien plus que l'image elle-même. En hiver, ou si votre panneau voit peu le soleil, allongez cet intervalle et relevez le seuil de pause.

Tous les seuils sont réglables, et les caméras filaires ne sont jamais concernées.

## Questions fréquentes

**L'image du tableau de bord est figée.**
Vérifiez l'intervalle de rafraîchissement dans la section Avancé. Si la caméra fonctionne sur batterie, elle est peut-être en pause : regardez son niveau de batterie.

**La vidéo en direct ne démarre pas.**
Le direct passe par le flux RTSP de la caméra. Lancez **Tester la connexion** : il indique quand RTSP est désactivé sur une caméra. Activez-le dans l'application Reolink (Paramètres → Réseau → Avancé → Paramètres du serveur), puis relancez un scan.

**Mes détections arrivent avec du retard.**
La caméra est vérifiée régulièrement au lieu de pousser ses événements. Lancez **Tester la connexion** : une caméra indiquée avec « détections vérifiées périodiquement » fonctionne sur batterie, se trouve derrière un Home Hub ou un NVR, ou a ONVIF désactivé. Dans ce dernier cas, activez ONVIF dans l'application Reolink et relancez un scan.

**Une caméra est trouvée mais Gladys indique que les identifiants sont refusés.**
Le compte utilisé doit être autorisé à lire les paramètres de la caméra. Un utilisateur restreint fonctionne, mais un compte « invité » n'a pas toujours les droits nécessaires.

**Mon projecteur s'éteint tout seul.**
La caméra applique son propre planning d'éclairage. Quand vous allumez le projecteur depuis Gladys, l'intégration élargit ce planning à toute la journée, puis remet vos propres réglages quand vous l'éteignez depuis Gladys. Une modification faite entre-temps dans l'application Reolink prend le dessus.

**Il manque une position dans la liste.**
Les positions sont lues à la découverte de la caméra. Relancez un scan après avoir enregistré une nouvelle position dans l'application Reolink.

**Une caméra de mon Home Hub n'apparaît pas.**
Le hub ne liste que les caméras qu'il peut joindre à cet instant. Vérifiez que la caméra est alimentée et à portée du hub, puis relancez un scan.

**Une caméra sur batterie ajoutée avant la version 1.4.0 n'a pas de fonctionnalité En charge.**
La fonctionnalité est nouvelle : ouvrez **Découverte**, lancez un scan et **mettez à jour** la caméra. La fonctionnalité est ajoutée ; les autres, leur historique et vos scènes sont conservés.
