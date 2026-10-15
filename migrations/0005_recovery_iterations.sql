-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Store the PBKDF2 iteration count with each recovery code, so changing
-- RECOVERY_PBKDF2_ITERATIONS only affects new codes. Codes created before this
-- migration keep NULL and are verified with the configured count, as before.
ALTER TABLE recovery_codes ADD COLUMN iterations INTEGER;
