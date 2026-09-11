# Funnel Doctor

Prototype de portfolio pour un agent d'observabilité du revenu destiné aux petites entreprises.

## Ce que montre la démo

- une vue funnel dédupliquée par session ;
- la séparation entre intention, checkout réellement créé et paiement confirmé ;
- une réconciliation comportementale entre Clarity et Stripe ;
- un diagnostic orienté action plutôt qu'une simple liste d'événements ;
- un export JSON des données de démonstration.

Les données sont fictives et explicitement marquées comme telles.

## Évolution prévue

1. Connecteurs en lecture seule pour Stripe, GA4, Clarity et Supabase.
2. Schéma commun : `session`, `product`, `funnel_stage`, `payment_status`, `source`.
3. Réconciliation par Checkout Session Stripe, jamais par le nombre brut d'événements.
4. Agent avec outils spécialisés : `get_funnel`, `reconcile_checkouts`, `inspect_session`, `audit_offer_consistency` et `suggest_experiment`.
5. Confirmation obligatoire avant toute action d'écriture (email, modification de prix ou campagne).

## Lancer localement

Ouvrir `index.html` dans un navigateur. Aucun compte, secret ou appel réseau n'est nécessaire pour la démo.
