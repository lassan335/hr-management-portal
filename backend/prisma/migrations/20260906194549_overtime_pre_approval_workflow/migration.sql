/*
  Warnings:

  - You are about to drop the column `hours` on the `OvertimeRequest` table. All the data in the column will be lost.
  - Added the required column `timeIn` to the `OvertimeRequest` table without a default value. This is not possible if the table is not empty.
  - Added the required column `timeOut` to the `OvertimeRequest` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "OvertimeRequest" DROP COLUMN "hours",
ADD COLUMN     "cancelled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "timeIn" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "timeOut" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "workCompleted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "workCompletedAt" TIMESTAMP(3);
