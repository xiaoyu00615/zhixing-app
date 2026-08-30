import { openWebTaskRepository } from '@/adapters/web'
import type { WebPersistenceCapability } from '@/adapters/web'
import type { Task } from '@/task/model'
import type { Project } from '@/project/model'
import type { Tag } from '@/tag/model'
import type {
  CreateProjectInput,
  ProjectRepository,
  RenameProjectInput,
} from '@/project/repository'
import type {
  CreateTagInput,
  RenameTagInput,
  TagRepository,
} from '@/tag/repository'
import type {
  ChangeTaskStatusInput,
  CreateTaskInput,
  RenameTaskInput,
  TaskRepository,
} from '@/task/repository'
import type { Canvas, CanvasEdge, CanvasNode } from '@/canvas/model'
import type {
  CanvasRepository,
  CreateCanvasInput,
  CreateCanvasNodeInput,
  CreateCanvasEdgeInput,
  CreateTextNodeInput,
  DeleteCanvasEdgeInput,
  MoveCanvasNodeInput,
  MoveCanvasNodesInput,
  RenameCanvasInput,
  RenameCanvasNodeInput,
  UpdateCanvasEdgeRelationTypeInput,
  UpdateCanvasEdgeDirectionInput,
  UpdateCanvasEdgeLineStyleInput,
  UpdateCanvasViewportInput,
  UpdateCanvasNodeContentInput,
  UpdateTextNodeInput,
} from '@/canvas/repository'

interface PersistenceHarness {
  capability(): Promise<WebPersistenceCapability>
  createTask(input: CreateTaskInput): Promise<Task>
  listTasks(): Promise<readonly Task[]>
  listTrashedTasks(): Promise<readonly Task[]>
  trashTask(input: import('@/task/repository').TrashTaskInput): Promise<Task>
  restoreTask(
    input: import('@/task/repository').RestoreTaskInput,
  ): Promise<Task>
  renameTask(input: RenameTaskInput): Promise<Task>
  changeTaskStatus(input: ChangeTaskStatusInput): Promise<Task>
  setTaskProject(
    input: import('@/task/repository').SetTaskProjectInput,
  ): Promise<Task>
  clearTaskProject(
    input: import('@/task/repository').ClearTaskProjectInput,
  ): Promise<Task>
  addTaskTag(input: import('@/task/repository').AddTaskTagInput): Promise<Task>
  removeTaskTag(
    input: import('@/task/repository').RemoveTaskTagInput,
  ): Promise<Task>
  createProject(input: CreateProjectInput): Promise<Project>
  listProjects(): Promise<readonly Project[]>
  renameProject(input: RenameProjectInput): Promise<Project>
  createTag(input: CreateTagInput): Promise<Tag>
  listTags(): Promise<readonly Tag[]>
  renameTag(input: RenameTagInput): Promise<Tag>
  createCanvas(input: CreateCanvasInput): Promise<Canvas>
  listCanvases(): Promise<readonly Canvas[]>
  getCanvas(id: string): Promise<Canvas>
  renameCanvas(input: RenameCanvasInput): Promise<Canvas>
  updateCanvasViewport(input: UpdateCanvasViewportInput): Promise<Canvas>
  createTextNode(input: CreateTextNodeInput): Promise<CanvasNode>
  createCanvasNode(input: CreateCanvasNodeInput): Promise<CanvasNode>
  listCanvasNodes(canvasId: string): Promise<readonly CanvasNode[]>
  updateTextNode(input: UpdateTextNodeInput): Promise<CanvasNode>
  updateCanvasNodeContent(input: UpdateCanvasNodeContentInput): Promise<CanvasNode>
  renameCanvasNode(input: RenameCanvasNodeInput): Promise<CanvasNode>
  moveCanvasNode(input: MoveCanvasNodeInput): Promise<CanvasNode>
  moveCanvasNodes(input: MoveCanvasNodesInput): Promise<readonly CanvasNode[]>
  createCanvasEdge(input: CreateCanvasEdgeInput): Promise<CanvasEdge>
  listCanvasEdges(canvasId: string): Promise<readonly CanvasEdge[]>
  updateCanvasEdgeRelationType(input: UpdateCanvasEdgeRelationTypeInput): Promise<CanvasEdge>
  updateCanvasEdgeDirection(input: UpdateCanvasEdgeDirectionInput): Promise<CanvasEdge>
  updateCanvasEdgeLineStyle(input: UpdateCanvasEdgeLineStyleInput): Promise<CanvasEdge>
  deleteCanvasEdge(input: DeleteCanvasEdgeInput): Promise<CanvasEdge>
  shutdown(): Promise<void>
}

declare global {
  interface Window {
    __taskPersistenceHarness: PersistenceHarness
  }
}

const opened = openWebTaskRepository()

async function requireRepository(): Promise<TaskRepository> {
  const result = await opened
  if (!('repository' in result)) {
    throw new Error('Task persistence is unavailable.')
  }
  return result.repository
}

async function requireProjectRepository(): Promise<ProjectRepository> {
  const result = await opened
  if (!('projectRepository' in result))
    throw new Error('Project persistence is unavailable.')
  return result.projectRepository
}

async function requireTagRepository(): Promise<TagRepository> {
  const result = await opened
  if (!('tagRepository' in result))
    throw new Error('Tag persistence is unavailable.')
  return result.tagRepository
}

async function requireCanvasRepository(): Promise<CanvasRepository> {
  const result = await opened
  if (!('canvasRepository' in result)) {
    throw new Error('Canvas persistence is unavailable.')
  }
  return result.canvasRepository
}

window.__taskPersistenceHarness = {
  async capability() {
    return (await opened).capability
  },
  async createTask(input) {
    return (await requireRepository()).createTask(input)
  },
  async listTasks() {
    return (await requireRepository()).listTasks()
  },
  async listTrashedTasks() {
    return (await requireRepository()).listTrashedTasks()
  },
  async trashTask(input) {
    return (await requireRepository()).trashTask(input)
  },
  async restoreTask(input) {
    return (await requireRepository()).restoreTask(input)
  },
  async renameTask(input) {
    return (await requireRepository()).renameTask(input)
  },
  async changeTaskStatus(input) {
    return (await requireRepository()).changeTaskStatus(input)
  },
  async setTaskProject(input) {
    return (await requireRepository()).setTaskProject(input)
  },
  async clearTaskProject(input) {
    return (await requireRepository()).clearTaskProject(input)
  },
  async addTaskTag(input) {
    return (await requireRepository()).addTaskTag(input)
  },
  async removeTaskTag(input) {
    return (await requireRepository()).removeTaskTag(input)
  },
  async createProject(input) {
    return (await requireProjectRepository()).createProject(input)
  },
  async listProjects() {
    return (await requireProjectRepository()).listProjects()
  },
  async renameProject(input) {
    return (await requireProjectRepository()).renameProject(input)
  },
  async createTag(input) {
    return (await requireTagRepository()).createTag(input)
  },
  async listTags() {
    return (await requireTagRepository()).listTags()
  },
  async renameTag(input) {
    return (await requireTagRepository()).renameTag(input)
  },
  async createCanvas(input) {
    return (await requireCanvasRepository()).createCanvas(input)
  },
  async listCanvases() {
    return (await requireCanvasRepository()).listCanvases()
  },
  async getCanvas(id) {
    return (await requireCanvasRepository()).getCanvas(id)
  },
  async renameCanvas(input) {
    return (await requireCanvasRepository()).renameCanvas(input)
  },
  async updateCanvasViewport(input) {
    return (await requireCanvasRepository()).updateCanvasViewport(input)
  },
  async createTextNode(input) {
    return (await requireCanvasRepository()).createTextNode(input)
  },
  async createCanvasNode(input) {
    return (await requireCanvasRepository()).createCanvasNode(input)
  },
  async listCanvasNodes(canvasId) {
    return (await requireCanvasRepository()).listCanvasNodes(canvasId)
  },
  async updateTextNode(input) {
    return (await requireCanvasRepository()).updateTextNode(input)
  },
  async updateCanvasNodeContent(input) {
    return (await requireCanvasRepository()).updateCanvasNodeContent(input)
  },
  async renameCanvasNode(input) {
    return (await requireCanvasRepository()).renameCanvasNode(input)
  },
  async moveCanvasNode(input) {
    return (await requireCanvasRepository()).moveCanvasNode(input)
  },
  async moveCanvasNodes(input) {
    return (await requireCanvasRepository()).moveCanvasNodes(input)
  },
  async createCanvasEdge(input) {
    return (await requireCanvasRepository()).createCanvasEdge(input)
  },
  async listCanvasEdges(canvasId) {
    return (await requireCanvasRepository()).listCanvasEdges(canvasId)
  },
  async updateCanvasEdgeRelationType(input) {
    return (await requireCanvasRepository()).updateCanvasEdgeRelationType(input)
  },
  async updateCanvasEdgeDirection(input) {
    return (await requireCanvasRepository()).updateCanvasEdgeDirection(input)
  },
  async updateCanvasEdgeLineStyle(input) {
    return (await requireCanvasRepository()).updateCanvasEdgeLineStyle(input)
  },
  async deleteCanvasEdge(input) {
    return (await requireCanvasRepository()).deleteCanvasEdge(input)
  },
  async shutdown() {
    const result = await opened
    if ('dispose' in result) {
      await result.dispose()
    }
  },
}

void opened.then((result) => {
  const output = document.querySelector('#capability')
  if (output !== null) {
    output.textContent = result.capability.status
  }
})

export {}
