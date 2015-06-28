"use strict";
var CONF = require("./config/conf"),    //综合配置
    handle = require("./common/handle"),//文本文件的模板操作
    middleware = require("./filter/middleware"),//支持中间件
    modules = require("./common/modules"),//支持的插件配置
    filter = require('./filter/filter'),//支持前置过滤器
    querystring = require("querystring"),
    zlib = require("zlib"),
    mime = require("mime"),    //MIME类型
    http = require("http"),
     url = require("url"),
      fs = require("fs");
var staticConf = CONF.staticconf,                //静态文件服务器配置
    mini = middleware.mini,
    cdn = middleware.cdn,
    serverInfo = {needUpdate: false};        //服务器相关的一些参数。
exports.start = function(conf){
    var server = http.createServer(function (req, resp) { try{
        var host = (req.headers.host + ':80').split(':'),
            pathurl,
            hostConf = CONF[ host[0] ],
            root,
            agent;
        if( hostConf && (host[1] | 0) === (hostConf.port | 0) ){ //域名识别
            conf = hostConf;
        }else if( (host[1] | 0) === 80 ){
            conf = CONF.localhost;
        }
        root = conf.root;
        if( typeof filter.execute(req,resp,conf) !== "undefined"){
            return false;   //有返回值的时候, 防止继续运行
        } //过滤器提前, 可以修改url
        try{pathurl = decodeURI(url.parse(req.url).pathname); }catch(e){ pathurl = req.url; }
        var pathname = root + pathurl;

        //包装request功能
        req.data = querystring.parse( url.parse(req.url).query );
        req.util = {mime: mime, conf: conf, host: host[0], staticServer: "http://" + ( staticConf.host || host[0] ) + ":" + staticConf.port + "/"};
        req.$ = {title: pathurl, fileList: [], needUpdate: serverInfo.needUpdate };
        resp.cdnPath = req.headers.host + req.url; // cdn 索引
        var DEBUG = req.data.debug === "true" || conf.debug; //DEBUG模式判断

        // 资源未找到时， 处理信息
        var other = function (_req, _resp, _handle, _conf, _pathurl){
            var m = modules.get( _pathurl.replace('/','') );
            if(m){
                m.execute(_req,_resp,_conf.root,_handle,_conf);
            }else if(_conf.agent && _conf.agent.get && (agent = _conf.agent.get(_pathurl) ) ){   // 代理过滤
                require('./filter/agent').execute(_req,_resp,agent,_req.url);
            }else{
                _resp.writeHead(404, {"Content-Type": "text/html"});
                fs.readFile(_conf.notFound || '', function (err, data){
                    if(err){
                        if( _conf.notFound ){ console.log(err); }
                        _resp.end( '<h1 style="font-size:200px;text-align:center;">404</h1>' );
                    }else{
                        _resp.end( data );
                    }
                });
            }
        };

        setTimeout( function(){
            try{    // 欢迎页面处理
                if( conf.welcome && fs.statSync(pathname).isDirectory() ){
                    pathname += '/' + conf.welcome;
                }
                if( req.data["modify.check"] === "true" ){ // modify.check=true 时: 检测文件更新
                    filter.check(pathname, req.data.mtime, req, resp);
                    return;
                }
            }catch(e){
                other(req, resp, handle, conf, pathurl);
                return;
            }
            resp.gzip = conf.gzip && mime.isTXT(pathname);

            fs.stat(pathname,function(error, stats){
                if(stats){
                    var expires = new Date();
                    expires.setTime( expires.getTime() + (conf.expires || 0) );
                    resp.writeHead(200, {
                        "Content-Type": mime.get(pathname),
                        "Content-Encoding": resp.gzip ? "gzip" : "utf-8",
                        "Expires": expires,
                        "Last-Modified": new Date( +stats.mtime ).toGMTString()
                    });
                }
                if(stats && stats.isFile()){  //如果url对应的资源文件存在，根据后缀名写入MIME类型
                    if( req.method === "POST" ){    // POST请求 添加target参数以后, 使用 upload 插件进行解析。
                        req.data.target = pathurl;
                        modules.get("upload").execute(req,resp,root,handle,conf);
                        return;
                    }


                    if( !conf.cdn ){    // cdn 禁用启用
                        cdn.disabled( host[0] );
                    }else{
                        cdn.enable( host[0] );
                        if( cdn.execute(req, resp, stats) ){
                            return;
                        }
                    }

                    var rs = fs.createReadStream(pathname), s = '', dataArr = [], ware;
                    rs.on('error',function(err){
                        throw err;
                    }).on('data',function(d){
                        s += d;
                        dataArr.push(d);
                    });

                    if( conf.middleware && (req.data.middleware !== "false") && (ware = middleware.get(pathname)) ){  //中间件处理, MIME需要mime.type中修改
                        rs.on('end',function(){
                            ware(req,resp,s,pathname,DEBUG);
                        });
                    }else if( conf.handle && mime.isTXT(pathname) && !( /[\.\-]min\.(js|css)$/.test(pathurl) ) && req.data.handle !== "false" ){    //handle
                        rs.on('end',function(){
                            handle.execute(req,resp,root,s, mini ,DEBUG, conf);
                        });
                    }else{
                        rs.on("end", function(){
                            var cdnBuf = Buffer.concat(dataArr, s.length );
                            cdn.set( resp, resp.gzip ? zlib.gzipSync(cdnBuf) : cdnBuf, +stats.mtime );
                        });
                        if( resp.gzip ){
                            rs.pipe( zlib.createGzip() ).pipe(resp);
                        }else{
                            rs.pipe(resp);
                        }
                    }
                } else if(conf.fs_mod && stats && stats.isDirectory()){  //如果当前url被成功映射到服务器的文件夹，创建一段列表字符串写出
                    require('./filter/directory').execute(req,resp,root,pathname,pathurl,conf,DEBUG);
                } else{
                    other(req, resp, handle, conf, pathurl);
                }
            });
        }, req.data.delay | 0 );// 增加delay参数，使得所有GET请求可以动态延时
    }catch(err){
        console.log(err.stack);
        resp.writeHead(500, {"Content-Type": "text/html"});
        resp.end( err.stack.toString().replace(/\n/g,"<br>") );
    }});
    server.maxConnections = conf.maxConnections;
    server.listen(conf.port);
    return server;
};

// 检测更新信息
try{
    require('./config/update').execute(serverInfo);
}catch(e){
    console.log( e );
}
