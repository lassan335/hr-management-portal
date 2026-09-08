-- CreateEnum
CREATE TYPE "StaffCategory" AS ENUM ('TEACHING', 'NON_TEACHING');

-- CreateEnum
CREATE TYPE "HolidayScope" AS ENUM ('ALL', 'TEACHING', 'NON_TEACHING');

-- AlterTable
ALTER TABLE "Holiday" ADD COLUMN     "scope" "HolidayScope" NOT NULL DEFAULT 'ALL';

-- AlterTable
ALTER TABLE "Staff" ADD COLUMN     "category" "StaffCategory" NOT NULL DEFAULT 'NON_TEACHING';
