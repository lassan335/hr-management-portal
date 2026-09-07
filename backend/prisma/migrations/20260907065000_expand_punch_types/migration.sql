-- Expand PunchType from a plain IN/OUT toggle to the six states a real
-- ZKTime 5.0 terminal (and the legacy portal) actually track: Check In/Out,
-- Break In/Out, Overtime In/Out. No existing rows reference the old values
-- at migration time (attendance demo data was cleared beforehand), so a
-- straight rename + new values is sufficient — no data backfill needed.
ALTER TYPE "PunchType" RENAME VALUE 'IN' TO 'CHECK_IN';
ALTER TYPE "PunchType" RENAME VALUE 'OUT' TO 'CHECK_OUT';
ALTER TYPE "PunchType" ADD VALUE 'BREAK_IN';
ALTER TYPE "PunchType" ADD VALUE 'BREAK_OUT';
ALTER TYPE "PunchType" ADD VALUE 'OVERTIME_IN';
ALTER TYPE "PunchType" ADD VALUE 'OVERTIME_OUT';
