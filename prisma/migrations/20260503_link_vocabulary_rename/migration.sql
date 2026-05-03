-- Rename link types: office_hours→bookable, contextual→personalized
-- Rename JSON-blob field names in User.preferences.explicit
BEGIN;

-- 1. NegotiationLink.type renames
UPDATE "NegotiationLink" SET "type" = 'bookable' WHERE "type" = 'office_hours';
UPDATE "NegotiationLink" SET "type" = 'personalized' WHERE "type" = 'contextual';

-- 2. JSONB sweep: User.preferences.explicit.structuredRules[*].action and field names
-- Dry-run count first (logged, not committed):
-- SELECT COUNT(*) FROM "User" WHERE preferences->'explicit'->'structuredRules' IS NOT NULL;

DO $$
DECLARE
  u RECORD;
  rules JSONB;
  rule JSONB;
  new_rules JSONB;
  i INT;
  updated_prefs JSONB;
  rows_touched INT := 0;
BEGIN
  FOR u IN SELECT id, preferences FROM "User" WHERE preferences IS NOT NULL LOOP
    rules := u.preferences->'explicit'->'structuredRules';
    IF rules IS NULL OR jsonb_array_length(rules) = 0 THEN CONTINUE; END IF;

    new_rules := '[]'::JSONB;
    FOR i IN 0..jsonb_array_length(rules)-1 LOOP
      rule := rules->i;

      -- Rename action value
      IF rule->>'action' = 'office_hours' THEN
        rule := jsonb_set(rule, '{action}', '"bookable"');
      END IF;

      -- Rename officeHours key → bookable
      IF rule ? 'officeHours' THEN
        rule := jsonb_set(rule, '{bookable}', rule->'officeHours') - 'officeHours';
      END IF;

      new_rules := new_rules || rule;
    END LOOP;

    updated_prefs := u.preferences;
    updated_prefs := jsonb_set(updated_prefs, '{explicit, structuredRules}', new_rules);

    -- Rename generalLinkName → primaryLinkName
    IF updated_prefs->'explicit' ? 'generalLinkName' THEN
      updated_prefs := jsonb_set(
        updated_prefs,
        '{explicit, primaryLinkName}',
        updated_prefs->'explicit'->'generalLinkName'
      ) #- '{explicit, generalLinkName}';
    END IF;

    UPDATE "User" SET preferences = updated_prefs WHERE id = u.id;
    rows_touched := rows_touched + 1;
  END LOOP;
  RAISE NOTICE 'JSONB sweep touched % user rows', rows_touched;
END $$;

COMMIT;
