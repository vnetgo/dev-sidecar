/**
 * 获取环境变量
 */
const fs = require('node:fs')
const path = require('node:path')
const request = require('request')
const Registry = require('winreg')
const log = require('../../../utils/util.log.core')
const Shell = require('../../shell')
const extraPath = require('../extra-path')
const dateUtil = require('../../../utils/util.date')

const execute = Shell.execute
const execFile = Shell.execFile

let config = null
function loadConfig () {
  if (config == null) {
    config = require('../../../config-api.js')
  }
}

function getDomesticDomainAllowListTmpFilePath () {
  return path.join(config.get().server.setting.userBasePath, '/domestic-domain-allowlist.txt')
}

async function downloadDomesticDomainAllowListAsync () {
  loadConfig()

  const remoteFileUrl = config.get().proxy.remoteDomesticDomainAllowListFileUrl
  log.info('开始下载远程 domestic-domain-allowlist.txt 文件:', remoteFileUrl)
  request(remoteFileUrl, (error, response, body) => {
    if (error) {
      log.error(`下载远程 domestic-domain-allowlist.txt 文件失败: ${remoteFileUrl}, error:`, error, ', response:', response, ', body:', body)
      return
    }
    if (response && response.statusCode === 200) {
      if (body == null || body.length < 100) {
        log.warn('下载远程 domestic-domain-allowlist.txt 文件成功，但内容为空或内容太短，判断为无效的 domestic-domain-allowlist.txt 文件:', remoteFileUrl, ', body:', body)
        return
      } else {
        log.info('下载远程 domestic-domain-allowlist.txt 文件成功:', remoteFileUrl)
      }

      let fileTxt = body
      try {
        if (!fileTxt.includes('*.')) {
          fileTxt = Buffer.from(fileTxt, 'base64').toString('utf8')
          // log.debug('解析 base64 后的 domestic-domain-allowlist:', fileTxt)
        }
      } catch {
        if (!fileTxt.includes('*.')) {
          log.error(`远程 domestic-domain-allowlist.txt 文件内容即不是base64格式，也不是要求的格式，url: ${remoteFileUrl}，body: ${body}`)
          return
        }
      }

      // 保存到本地
      saveDomesticDomainAllowListFile(fileTxt)
    } else {
      log.error(`下载远程 domestic-domain-allowlist.txt 文件失败: ${remoteFileUrl}, response:`, response, ', body:', body)
    }
  })
}

function loadLastModifiedTimeFromTxt (fileTxt) {
  const matched = fileTxt.match(/(?<=; Update Date: )[^\r\n]+/g)
  if (matched && matched.length > 0) {
    try {
      return new Date(matched[0])
    } catch {
      return null
    }
  }
}

// 保存 国内域名白名单 内容到 `~/domestic-domain-allowlist.txt` 文件中
function saveDomesticDomainAllowListFile (fileTxt) {
  const filePath = getDomesticDomainAllowListTmpFilePath()
  try {
    fs.writeFileSync(filePath, fileTxt.replaceAll(/\r\n?/g, '\n'))
    log.info('保存 domestic-domain-allowlist.txt 文件成功:', filePath)
  } catch (e) {
    log.error('保存 domestic-domain-allowlist.txt 文件失败:', filePath, ', error:', e)
    return
  }

  // 尝试解析和修改 domestic-domain-allowlist.txt 文件时间
  const lastModifiedTime = loadLastModifiedTimeFromTxt(fileTxt)
  if (lastModifiedTime) {
    fs.stat(filePath, (err, _stats) => {
      if (err) {
        log.error('修改 domestic-domain-allowlist.txt 文件时间失败:', err)
        return
      }

      // 修改文件的访问时间和修改时间为当前时间
      fs.utimes(filePath, lastModifiedTime, lastModifiedTime, (utimesErr) => {
        if (utimesErr) {
          log.error('修改 domestic-domain-allowlist.txt 文件时间失败:', utimesErr)
        } else {
          log.info(`'${filePath}' 文件的修改时间已更新为其最近更新时间 '${dateUtil.format(lastModifiedTime, false)}'`)
        }
      })
    })
  }
}

function getDomesticDomainAllowList () {
  loadConfig()

  if (!config.get().proxy.excludeDomesticDomainAllowList) {
    return null
  }

  // 判断是否需要自动更新国内域名
  let fileAbsolutePath = config.get().proxy.domesticDomainAllowListFileAbsolutePath
  if (!fileAbsolutePath && config.get().proxy.autoUpdateDomesticDomainAllowList) {
    // 异步下载，下载成功后，下次系统代理生效
    downloadDomesticDomainAllowListAsync().then()
  }

  // 加载本地文件
  if (!fileAbsolutePath) {
    const tmpFilePath = getDomesticDomainAllowListTmpFilePath()
    if (fs.existsSync(tmpFilePath)) {
      // 如果临时文件已存在，则使用临时文件
      fileAbsolutePath = tmpFilePath
      log.info('读取已下载的 domestic-domain-allowlist.txt 文件:', fileAbsolutePath)
    } else {
      // 如果临时文件不存在，则使用内置文件
      log.info('__dirname:', __dirname)
      fileAbsolutePath = path.join(__dirname, '../', config.get().proxy.domesticDomainAllowListFilePath)
      log.info('读取内置的 domestic-domain-allowlist.txt 文件:', fileAbsolutePath)
    }
  } else {
    log.info('读取自定义路径的 domestic-domain-allowlist.txt 文件:', fileAbsolutePath)
  }

  try {
    return fs.readFileSync(fileAbsolutePath).toString()
  } catch (e) {
    log.error(`读取 domestic-domain-allowlist.txt 文件失败: ${fileAbsolutePath}, error:`, e)
    return null
  }
}

function getProxyExcludeIpStr (split) {
  const proxyExcludeIpConfig = config.get().proxy.excludeIpList

  let excludeIpStr = ''
  for (const ip in proxyExcludeIpConfig) {
    if (proxyExcludeIpConfig[ip] === true) {
      excludeIpStr += ip + split
    }
  }

  // 排除国内域名
  // log.debug('系统代理排除域名（excludeIpStr）:', excludeIpStr)
  if (config.get().proxy.excludeDomesticDomainAllowList) {
    try {
      const domesticDomainAllowList = getDomesticDomainAllowList()
      if (domesticDomainAllowList) {
        const domesticDomainList = (`\n${domesticDomainAllowList}`).replaceAll(/[\r\n]+/g, '\n').match(/(?<=\n)(?:[\w\-.*]+|\[[\w:]+\])(?=\n)/g)
        if (domesticDomainList && domesticDomainList.length > 0) {
          for (const domesticDomain of domesticDomainList) {
            if (proxyExcludeIpConfig[domesticDomain] !== false) {
              excludeIpStr += domesticDomain + split
            } else {
              log.info('系统代理排除列表拼接国内域名时，跳过域名，系统代理将继续代理它:', domesticDomain)
            }
          }
          log.info('系统代理排除列表拼接国内域名成功')
        } else {
          log.info('国内域名为空，不进行系统代理排除列表拼接国内域名')
        }
      }
    } catch (e) {
      log.error('系统代理排除列表拼接国内域名失败:', e)
    }
  }

  return excludeIpStr
}

const executor = {
  async windows (exec, params = {}) {
    const { ip, port, setEnv } = params
    if (ip != null) { // 设置代理
      // 延迟加载config
      loadConfig()

      log.info('开始设置windows系统代理:', ip, port, setEnv)

      // https
      let proxyAddr = `https=http://${ip}:${port}`
      // http
      if (config.get().proxy.proxyHttp) {
        proxyAddr = `http=http://${ip}:${port - 1};${proxyAddr}`
      }

      // 读取排除域名
      const excludeIpStr = getProxyExcludeIpStr(';')
      // 设置代理，同时设置排除域名
      try {
        require('@starknt/sysproxy').triggerManualProxyByUrl(true, proxyAddr, excludeIpStr, true)
        log.info(`设置windows系统代理成功: ${proxyAddr} ......(省略排除IP列表)`)
      } catch (e1) {
        log.warn('设置windows系统代理失败：执行 `@starknt/sysproxy` 失败，现尝试通过执行 `sysproxy.exe global ...` 来设置系统代理！\r\n捕获的异常:', e1)

        const proxyPath = extraPath.getProxyExePath()
        const execFun = 'global'
        try {
          await execFile(proxyPath, [execFun, proxyAddr, excludeIpStr])
          log.info(`设置windows系统代理成功，执行的命令：${proxyPath} ${execFun} ${proxyAddr} ......(省略排除IP列表)`)
        } catch (e2) {
          log.error(`设置windows系统代理失败，执行的命令：${proxyPath} ${execFun} ${proxyAddr} ......(省略排除IP列表), error:`, e2)
          throw e1 // 将上面的异常抛出
        }
      }

      if (setEnv) {
        // 设置全局代理所需的环境变量
        try {
          await exec(`echo '设置环境变量 HTTPS_PROXY${config.get().proxy.proxyHttp ? '、HTTP_PROXY' : ''}'`)

          log.info(`开启系统代理的同时设置环境变量：HTTPS_PROXY = "http://${ip}:${port}/"`)
          await exec(`setx HTTPS_PROXY "http://${ip}:${port}/"`)

          if (config.get().proxy.proxyHttp) {
            log.info(`开启系统代理的同时设置环境变量：HTTP_PROXY = "http://${ip}:${port - 1}/"`)
            await exec(`setx HTTP_PROXY "http://${ip}:${port - 1}/"`)
          }

          //  await addClearScriptIni()
        } catch (e) {
          log.error('设置环境变量 HTTPS_PROXY、HTTP_PROXY 失败:', e)
        }
      }

      return true
    } else { // 关闭代理
      try {
        log.info('开始关闭windows系统代理')
        require('@starknt/sysproxy').triggerManualProxy(false, '', 0, '')
        log.info('关闭windows系统代理成功')
      } catch (e1) {
        log.error('关闭windows系统代理失败：执行 `@starknt/sysproxy` 失败，现尝试通过执行 `sysproxy.exe set 1` 来关闭系统代理！\r\n捕获的异常:', e1)

        try {
          const proxyPath = extraPath.getProxyExePath()
          await execFile(proxyPath, ['set', '1'])
          log.info('关闭windows系统代理成功，执行的命令：sysproxy.exe set 1')
        } catch (e2) {
          log.error('关闭windows系统代理失败，执行的命令：sysproxy.exe set 1, error:', e2)
          throw e1 // 将上面的异常抛出
        }
      }

      try {
        await exec('echo \'删除环境变量 HTTPS_PROXY、HTTP_PROXY\'')
        const regKey = new Registry({ // new operator is optional
          hive: Registry.HKCU, // open registry hive HKEY_CURRENT_USER
          key: '\\Environment', // key containing autostart programs
        })
        regKey.get('HTTPS_PROXY', (err) => {
          if (!err) {
            regKey.remove('HTTPS_PROXY', async (err) => {
              log.warn('删除环境变量 HTTPS_PROXY 失败:', err)
              await exec('setx DS_REFRESH "1"')
            })
          }
        })
        regKey.get('HTTP_PROXY', (err) => {
          if (!err) {
            regKey.remove('HTTP_PROXY', async (err) => {
              log.warn('删除环境变量 HTTP_PROXY 失败:', err)
            })
          }
        })
      } catch (e) {
        log.error('删除环境变量 HTTPS_PROXY、HTTP_PROXY 失败:', e)
      }

      return true
    }
  },
  async linux (exec, params = {}) {
    const { ip, port } = params
    if (ip != null) { // 设置代理
      // 延迟加载config
      loadConfig()

      // https
      const setProxyCmd = [
        'gsettings set org.gnome.system.proxy mode manual',
        `gsettings set org.gnome.system.proxy.https host ${ip}`,
        `gsettings set org.gnome.system.proxy.https port ${port}`,
      ]
      // http
      if (config.get().proxy.proxyHttp) {
        setProxyCmd.push(`gsettings set org.gnome.system.proxy.http host ${ip}`)
        setProxyCmd.push(`gsettings set org.gnome.system.proxy.http port ${port - 1}`)
      } else {
        setProxyCmd.push('gsettings set org.gnome.system.proxy.http host \'\'')
        setProxyCmd.push('gsettings set org.gnome.system.proxy.http port 0')
      }

      // 设置排除域名（ignore-hosts）
      const excludeIpStr = getProxyExcludeIpStr('\', \'')
      setProxyCmd.push(`gsettings set org.gnome.system.proxy ignore-hosts "['${excludeIpStr}']"`)

      await exec(setProxyCmd)
    } else { // 关闭代理
      const setProxyCmd = [
        'gsettings set org.gnome.system.proxy mode none',
      ]
      await exec(setProxyCmd)
    }
  },
  async mac (exec, params = {}) {
    // exec = _exec
    let wifiAdaptor = await exec('sh -c "networksetup -listnetworkserviceorder | grep `route -n get 0.0.0.0 | grep \'interface\' | cut -d \':\' -f2` -B 1 | head -n 1 "')
    wifiAdaptor = wifiAdaptor.trim()
    wifiAdaptor = wifiAdaptor.substring(wifiAdaptor.indexOf(' ')).trim()
    const { ip, port } = params
    if (ip != null) { // 设置代理
      // 延迟加载config
      loadConfig()

      // https
      await exec(`networksetup -setsecurewebproxy "${wifiAdaptor}" ${ip} ${port}`)
      // http
      if (config.get().proxy.proxyHttp) {
        await exec(`networksetup -setwebproxy "${wifiAdaptor}" ${ip} ${port - 1}`)
      } else {
        await exec(`networksetup -setwebproxystate "${wifiAdaptor}" off`)
      }

      // 设置排除域名
      const excludeIpStr = getProxyExcludeIpStr('" "')
      await exec(`networksetup -setproxybypassdomains "${wifiAdaptor}" "${excludeIpStr}"`)

      // const setEnv = `cat <<ENDOF >>  ~/.zshrc
      // export http_proxy="http://${ip}:${port}"
      // export https_proxy="http://${ip}:${port}"
      // ENDOF
      // source ~/.zshrc
      // `
      // await exec(setEnv)
    } else { // 关闭代理
      // https
      await exec(`networksetup -setsecurewebproxystate "${wifiAdaptor}" off`)
      // http
      await exec(`networksetup -setwebproxystate "${wifiAdaptor}" off`)

      // const removeEnv = `
      // sed -ie '/export http_proxy/d' ~/.zshrc
      // sed -ie '/export https_proxy/d' ~/.zshrc
      // source ~/.zshrc
      // `
      // await exec(removeEnv)
    }
  },
}

module.exports = async function (args) {
  return execute(executor, args)
}
