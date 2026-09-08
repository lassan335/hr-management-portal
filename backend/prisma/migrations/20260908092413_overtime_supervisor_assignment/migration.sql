-- AlterTable
ALTER TABLE "OvertimeRequest" ADD COLUMN     "assignedById" TEXT;

-- AlterTable
ALTER TABLE "Staff" ADD COLUMN     "canSupervise" BOOLEAN NOT NULL DEFAULT false;

-- AddForeignKey
ALTER TABLE "OvertimeRequest" ADD CONSTRAINT "OvertimeRequest_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
