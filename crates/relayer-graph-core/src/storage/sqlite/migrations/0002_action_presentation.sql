ALTER TABLE actions
    ADD COLUMN variant TEXT NOT NULL DEFAULT 'pill'
    CHECK(variant IN ('chip', 'pill', 'wide', 'card'));

ALTER TABLE actions ADD COLUMN icon TEXT;

ALTER TABLE actions ADD COLUMN description TEXT;
