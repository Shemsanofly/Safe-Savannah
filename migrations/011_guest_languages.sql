-- More guest languages: French, German, Italian, Spanish and Simplified Chinese join English and Kiswahili.
-- Alert and roll-call text is stored in every language so each guest sees their own.
ALTER TABLE tourists DROP CONSTRAINT IF EXISTS tourists_language_check;
ALTER TABLE tourists ADD CONSTRAINT tourists_language_check CHECK (language IN ('en', 'sw', 'fr', 'de', 'it', 'es', 'zh'));
ALTER TABLE tourist_alerts ADD COLUMN content jsonb;      -- { "fr": { "title": …, "body": …, "actions": [...] }, … }
ALTER TABLE guest_checks ADD COLUMN reason_i18n jsonb;    -- { "fr": "Lion près de …", … }
