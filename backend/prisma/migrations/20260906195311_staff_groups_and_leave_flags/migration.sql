-- AlterTable
ALTER TABLE "LeaveType" ADD COLUMN     "deductsBalance" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Staff" ADD COLUMN     "staffGroupId" TEXT;

-- CreateTable
CREATE TABLE "StaffGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "frameworkType" TEXT NOT NULL,
    "signInTime" TEXT NOT NULL,
    "workingHours" INTEGER NOT NULL,
    "groupCapping" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "StaffGroup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StaffGroup_name_key" ON "StaffGroup"("name");

-- AddForeignKey
ALTER TABLE "Staff" ADD CONSTRAINT "Staff_staffGroupId_fkey" FOREIGN KEY ("staffGroupId") REFERENCES "StaffGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
