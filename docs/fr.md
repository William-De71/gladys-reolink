# Reolink dans Gladys

Cette intégration ajoute vos caméras **Reolink** à Gladys : l'image sur le tableau de bord, la vidéo en direct, les détections comme déclencheurs de scènes, et le contrôle du projecteur, de la sirène ou des positions PTZ selon le modèle.

Tout se passe **sur votre réseau local**. Aucun compte Reolink n'est nécessaire et aucune image ne transite par un cloud.

## Ce dont vous avez besoin

- Une ou plusieurs caméras Reolink sur le même réseau que Gladys.
- L'identifiant et le mot de passe que vous utilisez pour vous connecter à ces caméras (celui de l'application Reolink, en général `admin`).

C'est tout. Il n'y a pas de compte à créer ni de clé d'API à demander.

## Installation

1. Dans Gladys, ouvrez **Intégrations → Installer une intégration** et installez Reolink.
2. Dans l'écran de configuration, renseignez l'**identifiant** et le **mot de passe** de vos caméras.
3. Cliquez sur **Tester la connexion** : Gladys cherche vos caméras et affiche ce que chacune sait faire.
4. Allez dans **Découverte** et lancez un scan : vos caméras y apparaissent, prêtes à être ajoutées.

### Si une caméra n'est pas trouvée

Gladys cherche vos caméras avec une diffusion réseau. Certains routeurs la filtrent, et une caméra sur un autre VLAN ne la reçoit jamais. Dans ce cas, saisissez son adresse dans **Adresses des caméras**, dans la section Avancé :

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

Chaque caméra reçoit **les fonctionnalités qu'elle possède réellement**. L'intégration interroge la caméra pour le savoir, plutôt que de se fier au nom du modèle : deux caméras d'une même gamme peuvent différer.

| Fonctionnalité  | Sur quelles caméras                |
| --------------- | ---------------------------------- |
| Image           | Toutes                             |
| Vidéo en direct | Toutes                             |
| Mouvement       | Toutes                             |
| Sonnette        | Sonnettes vidéo                    |
| Batterie        | Modèles sur batterie et solaires   |
| Projecteur      | Modèles avec projecteur blanc      |
| Sirène          | Modèles avec haut-parleur d'alarme |
| Infrarouge      | La plupart des modèles             |
| Position PTZ    | Caméras motorisées                 |

### Les détections

Les caméras Reolink ne tiennent pas d'historique d'événements : elles indiquent leur **état courant**. Gladys les interroge donc régulièrement, et l'intervalle de vérification est aussi le délai de détection. Il est réglé sur 15 secondes par défaut ; vous pouvez le descendre pour réagir plus vite, au prix d'une sollicitation plus fréquente des caméras.

Une détection déclenche aussi la capture d'une image, pour que le widget montre ce qui s'est passé sans attendre.

> **Détection personne / véhicule / animal.** Les caméras récentes distinguent ces trois types de détection, mais Gladys ne sait pas encore les afficher correctement : elles apparaîtraient comme des fonctionnalités sans nom ni icône. Elles sont donc mises en attente, et reviendront dès que Gladys les prendra en charge. La détection de mouvement, elle, fonctionne sur toutes les caméras.

### Les positions PTZ

Sur une caméra motorisée, la fonctionnalité « Position » attend un **numéro**, celui de la position enregistrée dans l'application Reolink. L'action **Lister les positions PTZ** affiche les numéros disponibles pour chaque caméra.

Dans une scène, envoyer `2` sur cette fonctionnalité déplace la caméra vers la position 2.

## Protection de la batterie

Capturer une image est ce qui vide le plus une caméra sur batterie ou solaire. L'intégration lève donc le pied avant que la batterie n'atteigne un niveau critique :

- **sous 60 %** : le rafraîchissement automatique s'arrête. Ouvrir le widget ou une détection capture toujours une image ;
- **sous 40 %** : plus aucune image n'est capturée ;
- **retour à la normale** dès que la caméra est remise en charge, ou une fois **80 %** atteints en solaire.

Ces 80 % sont volontairement bien au-dessus du seuil de pause : une reprise juste au-dessus relancerait la décharge aussitôt. Évitez de régler ce niveau à 100 % — une caméra solaire se recharge par à-coups et atteint rarement le plein exact, ce qui la laisserait en pause indéfiniment, sans chargeur sur lequel la poser.

Le niveau de batterie et les détections continuent d'être lus dans tous les cas : cela ne coûte presque rien, et c'est ce qui permet de savoir quand la caméra est rechargée.

Une caméra sur batterie qui **cesse de répondre** — veille profonde, session refusée, réseau coupé — est également ramenée au mode « à la demande » : son dernier niveau connu n'est plus fiable, et une caméra muette a plus de chances d'être vide que pleine.

### Un intervalle de capture propre aux caméras sur batterie

Les caméras sur batterie ont leur **propre intervalle de rafraîchissement**, indépendant de celui des caméras filaires. Espacer les captures d'un modèle solaire ne dégrade donc pas la fraîcheur des images de vos caméras sur secteur.

| Réglage                                                 | Par défaut     | Concerne                       |
| ------------------------------------------------------- | -------------- | ------------------------------ |
| Intervalle de rafraîchissement des images               | 60 s           | caméras sur secteur uniquement |
| Intervalle de rafraîchissement des caméras sur batterie | 900 s (15 min) | caméras sur batterie/solaires  |

C'est le réglage le plus efficace de tous : c'est le **réveil** de la caméra qui coûte de la batterie, bien plus que l'image elle-même. En hiver, ou si votre panneau est peu exposé, allongez cet intervalle et montez le seuil de pause.

Tous les seuils sont réglables, et les caméras filaires ne sont jamais concernées.

## Questions fréquentes

**L'image du tableau de bord est figée.**
Vérifiez l'intervalle de rafraîchissement dans la section Avancé. Si la caméra est sur batterie, elle est peut-être en pause : consultez son niveau de batterie.

**La vidéo en direct ne démarre pas.**
Le direct passe par le flux RTSP de la caméra. Vérifiez que RTSP est activé dans les paramètres de la caméra (application Reolink → Paramètres → Réseau avancé → Serveur RTSP).

**Une caméra a été trouvée mais Gladys dit que les identifiants sont refusés.**
Le compte utilisé doit pouvoir lire les paramètres de la caméra. Un utilisateur restreint fonctionne, mais un compte « invité » n'a pas toujours les droits nécessaires.

**Mon projecteur s'éteint tout seul.**
La caméra applique son propre programme horaire. L'intégration élargit ce programme quand vous allumez le projecteur depuis Gladys, mais un changement fait ensuite dans l'application Reolink reprend la main.

**Mes caméras sur batterie reliées à un Home Hub n'apparaissent pas.**
Cette version gère les caméras autonomes. Un NVR ou un Home Hub expose plusieurs caméras derrière une seule adresse, ce qui n'est pas encore pris en charge.
