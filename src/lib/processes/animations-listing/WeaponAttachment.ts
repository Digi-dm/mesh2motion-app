import { type Object3D, Bone, MathUtils, type SkinnedMesh } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { ModalDialog } from '../../ModalDialog.ts'
import { type CustomTransformControls } from '../../components/CustomTransformControls.ts'

export interface WeaponManifestEntry {
  id: string
  name: string
  file: string
  thumbnail: string
  license?: string
}

interface AttachmentOffsets {
  position: { x: number, y: number, z: number }
  rotation: { x: number, y: number, z: number } // degrees
  scale: number
}

/**
 * A single placed weapon instance. The same weapon model can be placed
 * multiple times (e.g. a bow on the back AND a bow in the hand) — visibility
 * per animation decides which instance shows when.
 */
export interface WeaponAttachmentInstance {
  id: number
  weapon_id: string
  display_name: string
  object: Object3D
  bone_name: string
  offsets: AttachmentOffsets
  // animation indices where this instance is HIDDEN (default: visible everywhere)
  hidden_indices: Set<number>
}

export interface WeaponExportEntry {
  node_name: string
  base_scale: number
  visible: boolean[]
}

/**
 * Multi-weapon attachment system.
 * - Attach any number of weapons/props to bones of the skinned mesh
 * - Each attachment has its own bone, offsets, and per-animation visibility
 * - The "active" attachment is the one edited by the bone/offset/gizmo controls
 *   and toggled by the sword icon on animation cards
 * - At export, each attachment gets a scale keyframe track per animation:
 *   full-size where visible, zero where hidden (portable glTF technique)
 */
export class WeaponAttachment extends EventTarget {
  public static readonly WEAPON_NODE_PREFIX = 'M2M_Weapon_'

  private readonly loader = new GLTFLoader()
  private readonly draco_loader = new DRACOLoader()

  private manifest: WeaponManifestEntry[] = []
  private skinned_meshes: SkinnedMesh[] = []

  private attachments: WeaponAttachmentInstance[] = []
  private active_attachment_id: number | null = null
  private next_attachment_id: number = 1

  private has_initialized_dom = false
  private transform_controls: CustomTransformControls | null = null
  private has_gizmo_listener = false

  private dom (id: string): HTMLInputElement | null {
    return document.querySelector(`#${id}`)
  }

  private dom_select (id: string): HTMLSelectElement | null {
    return document.querySelector(`#${id}`)
  }

  public active_attachment (): WeaponAttachmentInstance | null {
    return this.attachments.find((a) => a.id === this.active_attachment_id) ?? null
  }

  public all_attachments (): WeaponAttachmentInstance[] {
    return this.attachments
  }

  /**
   * Wire in the engine's shared transform controls for viewport gizmo editing.
   */
  public set_transform_controls (controls: CustomTransformControls): void {
    this.transform_controls = controls

    if (!this.has_gizmo_listener) {
      this.has_gizmo_listener = true
      controls.addEventListener('objectChange', () => {
        const active = this.active_attachment()
        if (active !== null && this.transform_controls?.object === active.object) {
          this.sync_offsets_from_object(active)
        }
      })
    }
  }

  private set_gizmo_mode (mode: 'translate' | 'rotate' | null): void {
    if (this.transform_controls === null) {
      return
    }
    const active = this.active_attachment()
    if (mode === null || active === null) {
      this.transform_controls.detach()
      this.transform_controls.enabled = false
      return
    }
    this.transform_controls.attach(active.object)
    this.transform_controls.setMode(mode)
    this.transform_controls.enabled = true
  }

  private sync_offsets_from_object (attachment: WeaponAttachmentInstance): void {
    const pos = attachment.object.position
    const rot = attachment.object.rotation
    attachment.offsets.position = { x: pos.x, y: pos.y, z: pos.z }
    attachment.offsets.rotation = {
      x: MathUtils.radToDeg(rot.x),
      y: MathUtils.radToDeg(rot.y),
      z: MathUtils.radToDeg(rot.z)
    }
    this.write_offsets_to_ui(attachment)
  }

  /**
   * Idempotent DOM setup. Called when entering the animations step.
   */
  public init (): void {
    if (this.has_initialized_dom) {
      return
    }
    this.has_initialized_dom = true

    // Many CC0 asset packs (e.g. the 3D Canvas compendium) use Draco compression
    this.draco_loader.setDecoderPath('draco/')
    this.loader.setDRACOLoader(this.draco_loader)

    void this.load_manifest()

    // choosing a weapon in the dropdown ADDS an attachment
    this.dom_select('weapon-select')?.addEventListener('change', (event) => {
      const value = (event.target as HTMLSelectElement).value
      if (value !== '') {
        void this.add_attachment(value)
        ;(event.target as HTMLSelectElement).value = ''
      }
    })

    this.dom_select('weapon-bone-select')?.addEventListener('change', (event) => {
      const active = this.active_attachment()
      if (active !== null) {
        this.attach_to_bone(active, (event.target as HTMLSelectElement).value)
      }
    })

    document.querySelector('#weapon-gizmo-move')?.addEventListener('click', () => { this.set_gizmo_mode('translate') })
    document.querySelector('#weapon-gizmo-rotate')?.addEventListener('click', () => { this.set_gizmo_mode('rotate') })
    document.querySelector('#weapon-gizmo-off')?.addEventListener('click', () => { this.set_gizmo_mode(null) })

    const offset_inputs = ['weapon-pos-x', 'weapon-pos-y', 'weapon-pos-z',
      'weapon-rot-x', 'weapon-rot-y', 'weapon-rot-z', 'weapon-scale-input']
    offset_inputs.forEach((id) => {
      this.dom(id)?.addEventListener('input', () => {
        const active = this.active_attachment()
        if (active !== null) {
          this.read_offsets_from_ui(active)
          this.apply_offsets(active)
        }
      })
    })

    // attachment list: click row to select, click x to remove
    document.querySelector('#weapon-attachment-list')?.addEventListener('click', (event) => {
      const target = event.target as HTMLElement
      const row = target.closest('[data-attachment-id]')
      if (row === null) {
        return
      }
      const id = Number(row.getAttribute('data-attachment-id'))
      if (target.classList.contains('weapon-remove-btn')) {
        this.remove_attachment(id)
      } else {
        this.select_attachment(id)
      }
    })
  }

  private async load_manifest (): Promise<void> {
    try {
      const response = await fetch('weapons/manifest.json')
      const data = await response.json()
      this.manifest = data.weapons ?? []
      this.populate_weapon_select()
    } catch (error) {
      console.warn('No weapon manifest found (static/weapons/manifest.json). Weapon library disabled.', error)
    }
  }

  private populate_weapon_select (): void {
    const select = this.dom_select('weapon-select')
    if (select === null) {
      return
    }
    select.innerHTML = '<option value="">+ Add weapon…</option>'
    this.manifest.forEach((entry) => {
      const option = document.createElement('option')
      option.value = entry.id
      option.textContent = entry.name
      select.appendChild(option)
    })
  }

  public set_skinned_meshes (meshes: SkinnedMesh[]): void {
    this.skinned_meshes = meshes
    this.populate_bone_select()

    // re-attach all weapons after mesh swap (bones are new objects now)
    this.attachments.forEach((attachment) => {
      this.attach_to_bone(attachment, attachment.bone_name)
    })
  }

  private all_bones (): Bone[] {
    const bones: Bone[] = []
    const seen = new Set<string>()
    this.skinned_meshes.forEach((mesh) => {
      mesh.skeleton.bones.forEach((bone) => {
        if (!seen.has(bone.name)) {
          seen.add(bone.name)
          bones.push(bone)
        }
      })
    })
    return bones
  }

  private populate_bone_select (): void {
    const select = this.dom_select('weapon-bone-select')
    if (select === null) {
      return
    }
    const previous_value = select.value
    select.innerHTML = ''
    const bones = this.all_bones()

    bones.forEach((bone) => {
      const option = document.createElement('option')
      option.value = bone.name
      option.textContent = bone.name
      select.appendChild(option)
    })

    if (previous_value !== '' && bones.some(b => b.name === previous_value)) {
      select.value = previous_value
    }
  }

  private guess_default_bone (): string {
    const bones = this.all_bones()
    const hand_guess = bones.find((bone) => /hand/i.test(bone.name) && /(_r$|r$|right)/i.test(bone.name)) ??
      bones.find((bone) => /hand/i.test(bone.name))
    return hand_guess?.name ?? bones[0]?.name ?? ''
  }

  public async add_attachment (weapon_id: string): Promise<void> {
    const entry = this.manifest.find((candidate) => candidate.id === weapon_id)
    if (entry === undefined) {
      return
    }

    let gltf
    try {
      gltf = await this.loader.loadAsync(entry.file)
    } catch (error) {
      console.error('Failed to load weapon:', entry.file, error)
      new ModalDialog('Weapon load failed', `Could not load ${entry.name}: ${String(error)}`).show()
      return
    }

    const attachment: WeaponAttachmentInstance = {
      id: this.next_attachment_id++,
      weapon_id,
      display_name: entry.name,
      object: gltf.scene,
      bone_name: this.guess_default_bone(),
      offsets: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: 1 },
      hidden_indices: new Set<number>()
    }
    attachment.object.name = `${WeaponAttachment.WEAPON_NODE_PREFIX}${attachment.id}`

    this.attachments.push(attachment)
    this.attach_to_bone(attachment, attachment.bone_name)
    this.select_attachment(attachment.id)
    this.dispatchEvent(new CustomEvent('weapon-changed'))
  }

  public select_attachment (id: number): void {
    const attachment = this.attachments.find((a) => a.id === id)
    if (attachment === undefined) {
      return
    }
    this.active_attachment_id = id

    const bone_select = this.dom_select('weapon-bone-select')
    if (bone_select !== null) {
      bone_select.value = attachment.bone_name
    }
    this.write_offsets_to_ui(attachment)
    this.render_attachment_list()

    // if gizmo is currently active, move it to the newly selected weapon
    if (this.transform_controls !== null && this.transform_controls.enabled) {
      this.transform_controls.attach(attachment.object)
    }

    // refresh card icons to reflect this attachment's visibility map
    this.dispatchEvent(new CustomEvent('weapon-changed'))
  }

  public remove_attachment (id: number): void {
    const attachment = this.attachments.find((a) => a.id === id)
    if (attachment === undefined) {
      return
    }
    if (this.transform_controls?.object === attachment.object) {
      this.set_gizmo_mode(null)
    }
    attachment.object.removeFromParent()
    this.attachments = this.attachments.filter((a) => a.id !== id)

    if (this.active_attachment_id === id) {
      this.active_attachment_id = this.attachments[0]?.id ?? null
      const next = this.active_attachment()
      if (next !== null) {
        this.write_offsets_to_ui(next)
        const bone_select = this.dom_select('weapon-bone-select')
        if (bone_select !== null) {
          bone_select.value = next.bone_name
        }
      }
    }
    this.render_attachment_list()
    this.dispatchEvent(new CustomEvent('weapon-changed'))
  }

  private render_attachment_list (): void {
    const container = document.querySelector('#weapon-attachment-list')
    if (container === null) {
      return
    }
    if (this.attachments.length === 0) {
      container.innerHTML = '<div style="opacity: 0.6; font-size: 0.85em;">No weapons attached</div>'
      return
    }
    container.innerHTML = this.attachments.map((attachment) => {
      const is_active = attachment.id === this.active_attachment_id
      const border = is_active ? '1px solid #69a1d0' : '1px solid transparent'
      const weight = is_active ? 'bold' : 'normal'
      return `<div data-attachment-id="${attachment.id}" style="display:flex; justify-content:space-between; align-items:center; padding:3px 6px; cursor:pointer; border:${border}; border-radius:4px; font-weight:${weight};">
        <span style="pointer-events:none;">${attachment.display_name} &rarr; ${attachment.bone_name}</span>
        <span class="weapon-remove-btn" title="Remove" style="cursor:pointer; padding:0 4px; opacity:0.7;">&#10005;</span>
      </div>`
    }).join('')
  }

  public attach_to_bone (attachment: WeaponAttachmentInstance, bone_name: string): void {
    if (bone_name === '') {
      return
    }
    const bone = this.all_bones().find((candidate) => candidate.name === bone_name)
    if (bone === undefined) {
      return
    }
    attachment.object.removeFromParent()
    bone.add(attachment.object)
    attachment.bone_name = bone_name
    this.apply_offsets(attachment)
    this.render_attachment_list()
  }

  private read_offsets_from_ui (attachment: WeaponAttachmentInstance): void {
    const num = (id: string, fallback: number): number => {
      const parsed = parseFloat(this.dom(id)?.value ?? '')
      return isNaN(parsed) ? fallback : parsed
    }
    attachment.offsets.position = { x: num('weapon-pos-x', 0), y: num('weapon-pos-y', 0), z: num('weapon-pos-z', 0) }
    attachment.offsets.rotation = { x: num('weapon-rot-x', 0), y: num('weapon-rot-y', 0), z: num('weapon-rot-z', 0) }
    attachment.offsets.scale = num('weapon-scale-input', 1)
  }

  private write_offsets_to_ui (attachment: WeaponAttachmentInstance): void {
    const set = (id: string, value: number): void => {
      const input = this.dom(id)
      if (input !== null) {
        input.value = Number(value.toFixed(3)).toString()
      }
    }
    set('weapon-pos-x', attachment.offsets.position.x)
    set('weapon-pos-y', attachment.offsets.position.y)
    set('weapon-pos-z', attachment.offsets.position.z)
    set('weapon-rot-x', attachment.offsets.rotation.x)
    set('weapon-rot-y', attachment.offsets.rotation.y)
    set('weapon-rot-z', attachment.offsets.rotation.z)
    set('weapon-scale-input', attachment.offsets.scale)
  }

  public apply_offsets (attachment: WeaponAttachmentInstance): void {
    attachment.object.position.set(
      attachment.offsets.position.x,
      attachment.offsets.position.y,
      attachment.offsets.position.z
    )
    attachment.object.rotation.set(
      MathUtils.degToRad(attachment.offsets.rotation.x),
      MathUtils.degToRad(attachment.offsets.rotation.y),
      MathUtils.degToRad(attachment.offsets.rotation.z)
    )
    attachment.object.scale.setScalar(attachment.offsets.scale)
  }

  public has_weapon (): boolean {
    return this.attachments.length > 0
  }

  /**
   * Visibility of the ACTIVE attachment in the given animation
   * (drives the card toggle icons).
   */
  public is_visible_in_animation (animation_index: number): boolean {
    const active = this.active_attachment()
    if (active === null) {
      return true
    }
    return !active.hidden_indices.has(animation_index)
  }

  /**
   * Toggle the ACTIVE attachment's visibility in the given animation.
   */
  public toggle_animation_visibility (animation_index: number): void {
    const active = this.active_attachment()
    if (active === null) {
      return
    }
    if (active.hidden_indices.has(animation_index)) {
      active.hidden_indices.delete(animation_index)
    } else {
      active.hidden_indices.add(animation_index)
    }
  }

  /**
   * Live preview: apply every attachment's visibility for the current animation.
   */
  public update_preview_visibility (current_animation_index: number): void {
    this.attachments.forEach((attachment) => {
      attachment.object.visible = !attachment.hidden_indices.has(current_animation_index)
    })
  }

  /**
   * Export info: one entry per attachment, each with per-animation visibility.
   */
  public get_export_info (animation_indices: number[]): WeaponExportEntry[] | null {
    if (this.attachments.length === 0) {
      return null
    }
    return this.attachments.map((attachment) => ({
      node_name: attachment.object.name,
      base_scale: attachment.offsets.scale,
      visible: animation_indices.map((index) => !attachment.hidden_indices.has(index))
    }))
  }
}
