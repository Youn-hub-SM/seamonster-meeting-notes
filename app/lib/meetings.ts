import fs from "fs/promises";
import path from "path";
import { Meeting } from "./types";

const DATA_DIR = path.join(process.cwd(), "data", "meetings");

export async function getAllMeetings(): Promise<Meeting[]> {
  try {
    const files = await fs.readdir(DATA_DIR);
    const jsonFiles = files.filter((f) => f.endsWith(".json"));

    const meetings = await Promise.all(
      jsonFiles.map(async (file) => {
        const content = await fs.readFile(path.join(DATA_DIR, file), "utf-8");
        return JSON.parse(content) as Meeting;
      })
    );

    return meetings.sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );
  } catch {
    return [];
  }
}

export async function getMeetingById(
  id: string
): Promise<Meeting | null> {
  try {
    const decoded = decodeURIComponent(id);
    const filePath = path.join(DATA_DIR, `${decoded}.json`);
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content) as Meeting;
  } catch {
    return null;
  }
}

export async function saveMeeting(meeting: Meeting): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const filePath = path.join(DATA_DIR, `${meeting.id}.json`);
  await fs.writeFile(filePath, JSON.stringify(meeting, null, 2), "utf-8");
}

export async function deleteMeeting(id: string): Promise<boolean> {
  try {
    const decoded = decodeURIComponent(id);
    const filePath = path.join(DATA_DIR, `${decoded}.json`);
    await fs.unlink(filePath);
    return true;
  } catch {
    return false;
  }
}
