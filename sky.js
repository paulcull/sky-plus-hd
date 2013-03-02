#!/usr/bin/node

var XML = require('xml'),
    _ = require('underscore'),
    http = require('http'),
    dgram = require('dgram'),
    xmlparser = require('xml2json');


var Sky = function(options) {

  var generateRequestXML = function(content) {
    var json = [
      {'s:Envelope': [
        {'_attr': {
          's:encodingStyle': 'http://schemas.xmlsoap.org/soap/encoding/',
          'xmlns:s': 'http://schemas.xmlsoap.org/soap/envelope/'
        }},
        {'s:Body':content}
      ]}
    ];
    return '<?xml version="1.0" encoding="utf-8"?>'+XML(json);
  }

  var request = function (soapAction,body,path,callback) {
    var httpParams = {
      hostname: options.host,
      port: options.port,
      path: options.overridePath || path,
      method: 'POST',
      headers: {
        'USER-AGENT': 'SKY_skyplus',
        'SOAPACTION': '"urn:schemas-nds-com:service:'+soapAction+'"',
        'CONTENT-TYPE': 'text/xml; charset="utf-8"'
      }
    };
    var req = http.request(httpParams, function(res) {
        res.setEncoding('utf8');
        res.on('data',function(chunk) {
          callback(JSON.parse(xmlparser.toJson(chunk))['s:Envelope']['s:Body']);
        });
    });
    req.write(body);
    req.end();
    req.on('error',function(e) {
      console.log("ERROR IN COMMS",e.message,e);
    });
  }

  var parseProgram = function(prog) {
    return {
      date: new Date(prog.s*1000),
      title: prog.t,
      description: prog.d,
      duration: prog.m[1]/60
    };
  }

  var getChannelListingPart = function(channelID,date,part,fnCallback) {
    var httpParams = {
      host: 'tv.sky.com',
      port: 80,
      path: '/programme/channel/'+channelID+'/'+date+'/'+part+'.json'
    };
    var progs = [];
    var req = http.request(httpParams,function(res) {
      res.setEncoding('utf8');
      var chunks = "";
      res.on('data',function(chunk) { chunks = chunks+chunk; });
      res.on('end',function() {
        var parsed = JSON.parse(chunks);
        for (var i in parsed.listings[channelID]) {
          var prog = parsed.listings[channelID][i];
          progs.push(parseProgram(prog));
        }
        fnCallback(progs);
      })
    });
    req.end();
  }

  /* ==== */

  this.detect = function(fnCallback) {
    var server = dgram.createSocket('udp4');
    server.on('message',function(msg,rinfo) {
      if (String(msg).indexOf('redsonic') > 1) {
        fnCallback({
          address: rinfo.address
        });
        server.close();
      };
    });
    server.bind(1900);
  };

  /* ==== */

  this.play = function() {
    var xml = generateRequestXML([
      {'u:Play':[
        {'_attr':{
          'xmlns:u': 'urn:schemas-nds-com:service:SkyPlay:2'
        }},
        {
          'InstanceID':0
        },
        {
          'Speed': 1
        }
      ]}
    ]);
    request("SkyPlay:2#Play",xml,'/SkyPlay2',function(response) {
      console.log(response);
    });
  };

  this.pause = function() {
    var xml = generateRequestXML([
      {'u:Pause':[
        {'_attr':{
          'xmlns:u': 'urn:schemas-nds-com:service:SkyPlay:2'
        }},
        {
          'InstanceID':0
        }
      ]}
    ]);
    request("SkyPlay:2#Pause",xml,'/SkyPlay2',function(response) {
      console.log(response);
    });
  };

  this.changeChannelHexID = function (id) {
    var xml = generateRequestXML([
      {'u:SetAVTransportURI':[
        {'_attr':{
          'xmlns:u': 'urn:schemas-nds-com:service:SkyPlay:2'
        }},
        {
          'InstanceID': 0
        },
        {
          'CurrentURI': 'xsi://'+id
        },
        {
          'CurrentURIMetaData': 'NOT_IMPLEMENTED'
        }
      ]}
    ]);
    request("SkyPlay:2#SetAVTransportURI",xml,'/SkyPlay2',function(response) {
      console.log(response);
    });
  }

  this.changeChannelID = function (id) {
    return this.changeChannelHexID(id.toString(16));
  }

  this.getMediaInfo = function(fnCallback) {
    var xml = generateRequestXML([
      {'u:GetMediaInfo':[
        {'_attr':{
          'xmlns:u': 'urn:schemas-nds-com:service:SkyPlay:2'
        }},
        {
          'InstanceID':0
        }
      ]}
    ]);
    request("SkyPlay:2#GetMediaInfo",xml,'/SkyPlay2',function(response) {
      var currentURI = response['u:GetMediaInfoResponse']['CurrentURI'];
      var info;
      if (currentURI.match(/^xsi:\/\//)) {
        var channelHexID = currentURI.replace(/^xsi:\/\//,'');
        info = {
          broadcast: true,
          channelHexID: channelHexID,
          channelID: parseInt(channelHexID,16)
        };
      } else if (currentURI.match(/^file:\/\/pvr\//)) {
        var pvrHexID = currentURI.replace(/^file:\/\/pvr\//,'');
        info = {
          broadcast: false,
          pvrHexID: pvrHexID,
          pvrID: parseInt(pvrHexID,16)
        };
      }
      fnCallback(info);
    });
  }

  this.getChannelListing = function (channelID,fnCallback) {
    var now = new Date(),
      year = now.getFullYear(),
      month = now.getUTCMonth() + 1,
      date = now.getUTCDate(),
      dateStr = year +'-'+ (month>9?month:'0'+month) +'-'+ (date>9?date:'0'+date),
      progs = [];

    var runCallback = _.after(4,function() {
      progs = progs.sort(function(a,b) {
        if (a.date.valueOf() == b.date.valueOf()) return 0;
        return (a.date.valueOf() > b.date.valueOf()) ? 1 : -1;
      });
      fnCallback(progs);
    });

    _.times(4,function(i) {
      getChannelListingPart(channelID,dateStr,i,function(progs_i) {
        progs = progs.concat(progs_i);
        runCallback();
      });
    });
  }

  this.whatsOn = function (channelId,fnCallback) {
    var httpParams = {
      host: 'epgservices.sky.com',
      port: 80,
      path: '/5.1.1/api/2.0/channel/json/'+channelId+'/now/nn/4'
    };
    var req = http.request(httpParams,function(res) {
      res.setEncoding('utf8');
      var chunks = "";
      res.on('data',function(chunk) { chunks = chunks+chunk; });
      res.on('end',function() {
        var parsed = JSON.parse(chunks);
        fnCallback({
          now: parseProgram(parsed.listings[channelId][0]),
          next: parseProgram(parsed.listings[channelId][1])
        });
      });
    });
    req.end();
  }

  var subscriptionSID = null;

  this.requestSubscription = function(host,port,fnCallback) {
    var httpParams = {
      host: options.host,
      port: options.port,
      path: '/SkyPlay2',
      method: 'SUBSCRIBE',
      headers: {
        callback: "<http://"+host+":"+port+"/uuid:444D5276-3253-6B79-436F-0019fb7d7534/urn:nds-com:serviceId:SkyPlay2>",
        nt: 'upnp:event'
      }
    };
    var req = http.request(httpParams,function(res) {
      res.setEncoding('utf8');
      var chunks = "";
      res.on('data',function(chunk) { chunks = chunks+chunk; });
      res.on('end',function() {
        fnCallback();
      });
      subscriptionSID = res.headers.sid || null;
    });
    req.end();
  };

  this.cancelSubscription = function(host,port,fnCallback) {
    if (!subscriptionSID) {
      console.log("No subscription to cancel");
      return;
    };
    console.log("Cancelling subscription with SID:",subscriptionSID);
    var httpParams = {
      host: options.host,
      port: options.port,
      path: '/SkyPlay2',
      method: 'UNSUBSCRIBE',
      headers: {
        SID: subscriptionSID
      }
    };
    subscriptionSID == null;

    var req = http.request(httpParams,function(res) {
      res.setEncoding('utf8');
      var chunks = "";
      res.on('data',function(chunk) { chunks = chunks+chunk; });
      res.on('end',function() {});
    });
    req.end();
  };

  this.monitor = function() {
    var monitorPort = 50000 + Math.round(Math.random()*15000);
    this.requestSubscription('192.168.1.150',monitorPort,function() {
      console.log("Subscribed with SID:",subscriptionSID,"on port:",monitorPort);
    });
    //
    var monitorServer = http.createServer(function(req,res) {
      console.log("NOTIFICATION");
      var chunks = "";
      req.on('data',function(chunk) { chunks += chunk });
      //req.on('end',function() { console.log(chunks); });
      res.writeHead(200,{'Content-Type':'text/plain'});
      res.end('OK');
    }).listen(monitorPort);

  };

};

/* ==== */

var s = new Sky({
  host: '192.168.1.193',
  port: 49153
});

s.getMediaInfo(function(data) {
  if (data.broadcast) {
    s.whatsOn(data.channelID, function(data) {
      console.log(data.now.title);
      console.log(data.now.description);
    });
  } else {
    console.log("Watching PVR id",data.pvrID);
  };
});

s.monitor();

process.on('exit',function() {
  s.cancelSubscription();
}).on('SIGINT',function() {
  process.exit();
});