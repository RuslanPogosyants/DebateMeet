import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const project = fileURLToPath(new URL('../../', import.meta.url))
const handle = '6a00:'

export type UdpBlock = {
  stats(): Promise<string>
  close(): Promise<string>
}

async function docker(args: string[]): Promise<string> {
  return (await execute('docker', args, { cwd: project, timeout: 15000 })).stdout.trim()
}

// This fault is limited to the running compose development SFU namespace. It never
// edits host routing, a production container, or an existing root traffic policy.
export async function blockDevLiveKitUdp(): Promise<UdpBlock> {
  const container = await docker(['compose', '--project-directory', project, 'ps', '-q', 'livekit'])
  if (!/^[a-f0-9]{12,64}$/u.test(container))
    throw new Error('One local LiveKit container is required')
  const [labelsText, image, mountsText, portsText] = await Promise.all([
    docker(['inspect', '--format', '{{json .Config.Labels}}', container]),
    docker(['inspect', '--format', '{{.Config.Image}}', container]),
    docker(['inspect', '--format', '{{json .Mounts}}', container]),
    docker(['inspect', '--format', '{{json .NetworkSettings.Ports}}', container]),
  ])
  const labels: unknown = JSON.parse(labelsText)
  const mounts: unknown = JSON.parse(mountsText)
  const ports: unknown = JSON.parse(portsText)
  if (
    labels === null ||
    typeof labels !== 'object' ||
    !('com.docker.compose.project' in labels) ||
    labels['com.docker.compose.project'] !== 'debatemeet' ||
    !('com.docker.compose.service' in labels) ||
    labels['com.docker.compose.service'] !== 'livekit' ||
    image !== 'livekit/livekit-server:v1.13.7' ||
    !Array.isArray(mounts) ||
    !mounts.some(
      (mount: unknown) =>
        mount !== null &&
        typeof mount === 'object' &&
        'Source' in mount &&
        mount.Source === `${project}deploy/dev/livekit.yaml`,
    ) ||
    ports === null ||
    typeof ports !== 'object' ||
    !('7882/udp' in ports)
  )
    throw new Error('The UDP probe requires the owned development LiveKit configuration')
  // --pull=never prevents this local experiment from downloading any helper image.
  const tc = (args: string[]) =>
    docker([
      'run',
      '--rm',
      '--pull=never',
      '--network',
      `container:${container}`,
      '--cap-add',
      'NET_ADMIN',
      '--entrypoint',
      'tc',
      'debatemeet-netem:dev',
      ...args,
    ])
  const before = await tc(['qdisc', 'show', 'dev', 'eth0'])
  if (
    before.split('\n').some((line) => line.includes(' root ') && !line.startsWith('qdisc noqueue '))
  )
    throw new Error('Refusing to replace an existing root traffic policy')
  await tc([
    'qdisc',
    'add',
    'dev',
    'eth0',
    'root',
    'handle',
    handle,
    'prio',
    'bands',
    '3',
    'priomap',
    ...Array<string>(16).fill('0'),
  ])
  let closed = false
  const stats = () => tc(['-s', 'qdisc', 'show', 'dev', 'eth0'])
  const close = async () => {
    if (closed) return tc(['qdisc', 'show', 'dev', 'eth0'])
    const current = await tc(['qdisc', 'show', 'dev', 'eth0'])
    if (!current.includes(`qdisc prio ${handle} root`))
      throw new Error('The owned traffic policy was replaced; refusing unrelated cleanup')
    await tc(['qdisc', 'del', 'dev', 'eth0', 'root', 'handle', handle])
    closed = true
    const after = await tc(['qdisc', 'show', 'dev', 'eth0'])
    if (after.includes(handle) || after.includes('netem'))
      throw new Error('The owned UDP fault was not removed')
    return after
  }
  try {
    await tc([
      'qdisc',
      'add',
      'dev',
      'eth0',
      'parent',
      '6a00:3',
      'handle',
      '6a03:',
      'netem',
      'loss',
      '100%',
    ])
    await tc([
      'filter',
      'add',
      'dev',
      'eth0',
      'protocol',
      'ip',
      'parent',
      handle,
      'prio',
      '1',
      'u32',
      'match',
      'ip',
      'protocol',
      '17',
      '0xff',
      'flowid',
      '6a00:3',
    ])
  } catch (error) {
    await close()
    throw error
  }
  return { stats, close }
}
