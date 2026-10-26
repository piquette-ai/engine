-- The project renamed from Super Portable Software Factory to Piquette: factories.spf_version becomes factories.piquette_version, matching the sync wire field (#piquette rename).
ALTER TABLE factories RENAME COLUMN spf_version TO piquette_version;
