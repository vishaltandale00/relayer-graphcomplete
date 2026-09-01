ALTER TABLE nodes ADD COLUMN authored_detail TEXT
    CHECK (authored_detail IS NULL OR json_valid(authored_detail));
