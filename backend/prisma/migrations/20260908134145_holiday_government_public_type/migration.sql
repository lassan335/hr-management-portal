-- CreateEnum
CREATE TYPE "HolidayType" AS ENUM ('GOVERNMENT', 'PUBLIC');

-- AlterTable
ALTER TABLE "Holiday" ADD COLUMN     "type" "HolidayType" NOT NULL DEFAULT 'PUBLIC';
